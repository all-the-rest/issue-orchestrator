import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { SQLiteStore, type AgentUsage, type PersistedAgentSession } from '../core/persistence.js';
import { AgentRunnerError, validateAgentResult } from './agent-result.js';
import { descriptor, type AgentRunner, type AgentSession, type AgentSessionStatus, type CreateAgentSessionArgs, type RunAgentSessionArgs, type AgentResult } from './ports.js';

const MAX_OUTPUT = 1024 * 1024;
const DEFAULT_TIMEOUT = 30 * 60_000;
// Deliberately omit HOME, XDG paths, and provider/Git/SSH credentials. A command
// adapter must not inherit the operator's CLI authentication context.
const SAFE_ENV = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'WINDIR'];
const GUARDIAN = `
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
let input = '';
const parent = process.ppid;
const socketPath = process.argv[2];
const token = process.argv[1];
let stopping = false;
let reported = false;
let command;
let server;
let parentWatch;
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (parentWatch) clearInterval(parentWatch);
  try { server.close(); } catch {}
  try { fs.unlinkSync(socketPath); } catch {}
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }, 1500);
};
const report = (code) => {
  if (reported) return;
  reported = true;
  try { fs.writeSync(3, JSON.stringify({ code }) + '\\n'); }
  catch { stop(); }
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server = net.createServer((connection) => {
  let request = '';
  connection.on('data', (chunk) => { request += chunk; });
  connection.on('end', () => {
    if (request === JSON.stringify({ op: 'stop', token })) {
      connection.end('ok');
      stop();
    } else connection.destroy();
  });
});
server.on('error', () => process.exit(23));
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\\n');
});
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let request;
  try { request = JSON.parse(input); } catch { process.exit(21); }
  if (request.token !== token || request.socket !== socketPath) process.exit(22);
  parentWatch = setInterval(() => { if (process.ppid !== parent) stop(); }, 100);
  parentWatch.unref();
  command = spawn(request.exe, request.args, {
    shell: false,
    cwd: request.cwd,
    env: request.env,
    // Output goes straight to parent-owned pipes so killing this group cannot
    // truncate bytes buffered in an intermediate guardian stream.
    stdio: ['pipe', 4, 5],
  });
  command.stdin.end(request.request);
  command.once('error', () => report(-1));
  command.once('exit', (code) => report(code ?? -1));
});
process.stdin.on('error', () => process.exit(2));
`;

export interface CommandRunnerOptions { executable: string; args?: string[]; timeoutMs?: number; storeProvider?: () => Pick<SQLiteStore, 'createAgentSession' | 'getAgentSession' | 'claimAgentSession' | 'completeAgentSession' | 'failAgentSession' | 'recordAgentSessionLaunchIntent' | 'recordAgentSessionProcess' | 'clearAgentSessionProcess'> }
type ProtocolResponse = { session_id?: string; result?: unknown; status?: AgentSessionStatus; started_at?: string; ended_at?: string | null };

interface ProcessIdentity { pid: number; pgid: number; state: string; start: string }
function macPs(args: string[]) {
  const result = spawnSync('/bin/ps', args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status === 1 && !(result.stdout ?? '').trim()) return '';
  if (result.error || result.status !== 0) throw new Error('could not verify macOS process identity');
  return result.stdout ?? '';
}
function processInfo(pid: number): ProcessIdentity | null {
  if (process.platform === 'linux') {
    let stat: string;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!fields[0] || !/^\d+$/.test(fields[19] ?? '')) throw new Error('invalid Linux process identity');
    return { pid, pgid: Number(fields[2]), state: fields[0], start: fields[19] };
  }
  if (process.platform === 'darwin') {
    const lines = macPs(['-p', String(pid), '-o', 'pid=,pgid=,lstart=,state=']).trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return null;
    if (lines.length !== 1) throw new Error('ambiguous macOS process identity');
    const p = lines[0].trim().split(/\s+/);
    if (p.length !== 8 || Number(p[0]) !== pid || !/^\d+$/.test(p[1])) throw new Error('invalid macOS process identity');
    return { pid, pgid: Number(p[1]), state: p[7], start: p.slice(2, 7).join(' ') };
  }
  throw new Error('safe command execution is supported only on Linux and macOS');
}
function processMembers(pgid: number) {
  if (process.platform === 'darwin') return macPs(['-g', String(pgid), '-o', 'pid=,pgid=,lstart=,state=']).trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const p = line.trim().split(/\s+/); if (p.length !== 8 || Number(p[1]) !== pgid) throw new Error('ambiguous macOS process group');
    return { pid: Number(p[0]), pgid, state: p[7], start: p.slice(2, 7).join(' ') };
  });
  if (process.platform !== 'linux') throw new Error('unsupported process platform');
  return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => { const info = processInfo(Number(name)); return info?.pgid === pgid ? [info] : []; });
}
function hasToken(pid: number, token: string) {
  if (process.platform === 'linux') {
    try { if (fs.readFileSync(`/proc/${pid}/environ`).toString().split('\0').includes(`ISSUE_ORCHESTRATOR_EXECUTION_ID=${token}`)) return true; }
    catch (error) { if (!['EACCES', 'ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    // The guardian also receives the unguessable token as its node -e argv;
    // /proc/<pid>/cmdline remains readable when ptrace policy hides environ.
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(token); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
  }
  return macPs(['-E', '-ww', '-p', String(pid), '-o', 'command=']).includes(token);
}
function verifiedMembers(identity: { pid: number; pgid: number; startTicks: string; token: string }, verifyToken = false) {
  const leader = processInfo(identity.pid);
  if (leader && (leader.pgid !== identity.pgid || leader.start !== identity.startTicks)) throw new Error('persisted process identity changed or PID was reused');
  const live = processMembers(identity.pgid).filter((p) => !/^[ZX]/i.test(p.state));
  let tokenAnchorFound = false;
  for (const p of live) {
    const again = processInfo(p.pid);
    if (!again || again.pgid !== identity.pgid || again.start !== p.start) throw new Error('process changed during identity verification');
    // The guardian normally anchors the group. If it exited while a child
    // survived, require the unguessable token inherited by that child before
    // signaling the numeric PGID; group membership alone is vulnerable to
    // PGID reuse. Refuse cleanup if the command scrubbed the token.
    if (verifyToken && hasToken(p.pid, identity.token)) tokenAnchorFound = true;
  }
  if (verifyToken && live.length > 0 && !tokenAnchorFound) throw new Error('no live process in the group has the persisted execution token');
  return live;
}
async function stopPersisted(identity: { pid: number | null; pgid: number | null; startTicks: string | null; token: string | null }) {
  if (identity.pid == null || identity.pgid == null || !identity.startTicks || !identity.token || (process.platform !== 'linux' && process.platform !== 'darwin')) throw new Error('unsupported or incomplete process identity');
  const exact = { pid: identity.pid, pgid: identity.pgid, startTicks: identity.startTicks, token: identity.token };
  let members = verifiedMembers(exact);
  const socket = socketPath(exact.token);
  if (!members.length) { cleanupSocket(socket); return; }
  let st: fs.Stats;
  try { st=fs.lstatSync(socket); } catch { throw new Error('guardian control socket is unavailable while process group is live'); }
  if (!st.isSocket() || st.uid !== process.getuid?.()) throw new Error('guardian control socket is unsafe');
  await new Promise<void>((resolve, reject) => { const s=net.createConnection(socket); s.setTimeout(1000); s.once('connect',()=>s.end(JSON.stringify({op:'stop',token:exact.token}))); s.once('data',d=>d.toString()==='ok'?resolve():reject(new Error('guardian rejected stop request'))); s.once('error',reject); s.once('timeout',()=>reject(new Error('guardian stop timed out'))); });
  const killDeadline = Date.now() + 5000;
  while (Date.now() < killDeadline) { members = verifiedMembers(exact); if (!members.length) { cleanupSocket(socket); return; } await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('process group did not stop');
}
function socketPath(token: string) { return path.join('/tmp', `io-${typeof process.getuid==='function'?process.getuid():0}-${createHash('sha256').update(token).digest('hex').slice(0,12)}`, 'c'); }
function ensureSocketDir(socket: string) { const dir=path.dirname(socket); try { fs.mkdirSync(dir,{mode:0o700}); } catch(e) { if ((e as NodeJS.ErrnoException).code!=='EEXIST') throw e; } const s=fs.lstatSync(dir); if(!s.isDirectory()||s.isSymbolicLink()||s.mode&0o077||s.uid!==process.getuid?.()) throw new Error('guardian socket directory is unsafe'); }
function cleanupSocket(socket: string) { try { const dir=fs.lstatSync(path.dirname(socket)); if(!dir.isDirectory()||dir.isSymbolicLink()||dir.mode&0o077||dir.uid!==process.getuid?.()) return; const entry=fs.lstatSync(socket); if(entry.isSocket()&&entry.uid===process.getuid?.()) fs.unlinkSync(socket); } catch {} try { fs.rmdirSync(path.dirname(socket)); } catch {} }

/** Each invocation exchanges one versioned JSON request/response with a trusted installed executable. */
export class CommandAgentRunner implements AgentRunner {
  readonly name = 'command';
  readonly capabilities = descriptor('command', 'AgentRunner', { createSession: true, run: true, resume: true, abort: true, getResult: true });
  private readonly options: CommandRunnerOptions;
  private readonly identity: string;
  private readonly storeProvider: NonNullable<CommandRunnerOptions['storeProvider']>;
  constructor(options: CommandRunnerOptions) {
    if (!options || typeof options.executable !== 'string' || !options.executable || options.executable.includes('\0')) throw new Error('command runner requires a trusted executable path');
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('command runner requires Linux or macOS process identity support');
    if (options.args && (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))) throw new Error('command runner args must be strings');
    this.options = { ...options, args: [...(options.args ?? [])] };
    this.identity = createHash('sha256').update(JSON.stringify([options.executable, options.args ?? []])).digest('hex').slice(0, 16);
    if (typeof options.storeProvider !== 'function') throw new Error('CommandAgentRunner requires an AgentSessionStore provider');
    this.storeProvider = options.storeProvider;
  }
  async createSession(args: CreateAgentSessionArgs): Promise<AgentSession> {
    const response = await this.invoke({ operation: 'createSession', session_id: null, input: args }, DEFAULT_TIMEOUT);
    const providerId = response.session_id;
    if (typeof providerId !== 'string' || !providerId || providerId.length > 256 || providerId.includes('.')) throw new AgentRunnerError('COMMAND_PROTOCOL_ERROR', 'command runner returned an invalid session identifier');
    const configIdentity = createHash('sha256').update(JSON.stringify([args.jobId, args.role, args.model, args.worktree])).digest('hex').slice(0, 16);
    const id = `${this.identity}.${configIdentity}.${providerId}`;
    const session: AgentSession = { runner: this.name, externalSessionId: id, jobId: args.jobId, role: args.role, model: args.model, worktree: args.worktree, status: response.status ?? 'CREATED', startedAt: response.started_at ?? new Date().toISOString(), endedAt: response.ended_at ?? null };
    this.storeProvider().createAgentSession({ runner: this.name, jobId: args.jobId, externalSessionId: id, role: args.role, model: args.model, worktree: args.worktree, ndjsonPath: '<command-private-log>', stderrPath: '<command-private-log>' });
    return session;
  }
  async run(args: RunAgentSessionArgs): Promise<AgentResult> { return this.turn('run', args); }
  async resume(args: RunAgentSessionArgs): Promise<AgentResult> { return this.turn('resume', args); }
  private async turn(operation: string, args: RunAgentSessionArgs): Promise<AgentResult> {
    if (args.systemPrompt !== undefined && (typeof args.systemPrompt !== 'string' || !args.systemPrompt.trim())) throw new AgentRunnerError('INVALID_AGENT_SESSION', 'systemPrompt must be a non-empty string', args.sessionId);
    if (args.input === undefined && (typeof args.prompt !== 'string' || !args.prompt.trim())) throw new AgentRunnerError('INVALID_AGENT_SESSION', 'run requires prompt or structured input', args.sessionId);
    const providerId = this.requireSession(args.sessionId);
    const record = this.requirePersisted(args.sessionId);
    this.assertConfig(record);
    const owner = randomUUID();
    const claim = this.storeProvider().claimAgentSession({ externalSessionId: args.sessionId, owner, leaseUntil: new Date(Date.now() + (args.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT) + 60_000).toISOString(), resume: operation === 'resume', continueCompleted: args.continueCompleted });
    if (!claim.acquired) throw new AgentRunnerError('AGENT_SESSION_BUSY', 'command session is already running or not reusable', args.sessionId);
    const usage: AgentUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    try {
    if (claim.recovering) {
      const previous = claim.previousProcess;
      if (!previous || !previous.token) throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'stale command session has no verified launch identity', args.sessionId);
      const gatedBeforeStart = previous.pid === null && previous.pgid === null && previous.startTicks === null &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previous.token);
      if (!gatedBeforeStart) {
        if (previous.pid == null || previous.pgid == null || !previous.startTicks) throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'stale command session has an incomplete process identity', args.sessionId);
        try { await stopPersisted(previous); }
        catch (error) {
          throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'stale command process-group ownership could not be verified or safely stopped', args.sessionId, error);
        }
      }
      if (!this.storeProvider().clearAgentSessionProcess(args.sessionId, owner)) throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'could not clear stale command process identity', args.sessionId);
    }
    const response = await this.invoke({
      operation,
      session_id: providerId,
      system_prompt: args.systemPrompt ?? null,
      input: args.input === undefined ? { prompt: args.prompt } : args.input,
    }, args.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT, { sessionId: args.sessionId, owner });
    const result = validateAgentResult(response.result);
    this.storeProvider().completeAgentSession({ externalSessionId: args.sessionId, owner, status: result.status, result, usage });
    return result;
    } catch (error) {
      if (!(error instanceof AgentRunnerError) || error.code !== 'AGENT_RECOVERY_UNSAFE') {
        try { this.storeProvider().failAgentSession({ externalSessionId: args.sessionId, owner, status: 'FAILED', errorClass: error instanceof AgentRunnerError ? error.code : 'COMMAND_FAILED', usage }); } catch { /* lease ownership may have expired */ }
      }
      throw error;
    }
  }
  async getResult(args: { sessionId: string }): Promise<AgentResult | null> {
    const providerId = this.requireSession(args.sessionId);
    const record = this.requirePersisted(args.sessionId);
    this.assertConfig(record);
    if (record.resultJson !== null) return validateAgentResult(JSON.parse(record.resultJson));
    const response = await this.invoke({ operation: 'getResult', session_id: providerId, input: null }, this.options.timeoutMs ?? DEFAULT_TIMEOUT);
    if (response.result == null) return null;
    const result = validateAgentResult(response.result);
    const owner = randomUUID();
    const claim = this.storeProvider().claimAgentSession({ externalSessionId: args.sessionId, owner, leaseUntil: new Date(Date.now() + 60_000).toISOString(), resume: true });
    if (claim.acquired) this.storeProvider().completeAgentSession({ externalSessionId: args.sessionId, owner, status: result.status, result, usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
    return result;
  }
  async abort(args: { sessionId: string }): Promise<boolean> {
    const providerId = this.requireSession(args.sessionId);
    const record = this.requirePersisted(args.sessionId); this.assertConfig(record);
    const response = await this.invoke({ operation: 'abort', session_id: providerId, input: null }, this.options.timeoutMs ?? DEFAULT_TIMEOUT);
    if (response.status === 'ABORTED') {
      const owner = randomUUID(); const claim = this.storeProvider().claimAgentSession({ externalSessionId: args.sessionId, owner, leaseUntil: new Date(Date.now() + 60_000).toISOString(), resume: true });
      if (claim.acquired) this.storeProvider().failAgentSession({ externalSessionId: args.sessionId, owner, status: 'ABORTED', errorClass: 'AGENT_ABORTED', usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
      return true;
    }
    return false;
  }
  private requirePersisted(id: string): PersistedAgentSession { const record = this.storeProvider().getAgentSession(id); if (!record || record.runner !== this.name) throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'command session is not persisted for this runner', id); return record; }
  private assertConfig(record: PersistedAgentSession) { const expected = createHash('sha256').update(JSON.stringify([record.jobId, record.role, record.model, record.worktree])).digest('hex').slice(0, 16); if (record.runner !== this.name || !record.externalSessionId.startsWith(`${this.identity}.${expected}.`) || !record.model || !record.worktree) throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'persisted command session configuration does not match', record.externalSessionId); }
  private requireSession(id: string): string {
    if (!id) throw new AgentRunnerError('INVALID_AGENT_SESSION', 'sessionId is required');
    const parts = id.split('.');
    if (parts.length !== 3 || parts[0] !== this.identity || !parts[1] || !parts[2]) throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'command session identity differs from configured executable or arguments', id);
    return parts[2];
  }
  private invoke(request: object, timeoutMs: number, context?: { sessionId: string; owner: string }): Promise<ProtocolResponse> {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return Promise.reject(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'verified command supervision is unsupported on this operating system', context?.sessionId));
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {};
      for (const key of SAFE_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
      let child;
      const token = randomUUID();
      const socket = socketPath(token);
      try { ensureSocketDir(socket); } catch (error) { reject(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'could not create a safe guardian control socket', context?.sessionId, error)); return; }
      env.ISSUE_ORCHESTRATOR_EXECUTION_ID = token;
       if (context && !this.storeProvider().recordAgentSessionLaunchIntent({ externalSessionId: context.sessionId, owner: context.owner, token })) { cleanupSocket(socket); reject(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'could not persist command launch intent', context.sessionId)); return; }
       try { child = spawn(process.execPath, ['-e', GUARDIAN, token, socket], { shell: false, env, stdio: ['pipe', 'pipe', 'ignore', 'pipe', 'pipe', 'pipe'], detached: true, windowsHide: true }); }
       catch { cleanupSocket(socket); reject(new AgentRunnerError('COMMAND_SPAWN_FAILED', 'configured agent command could not be started')); return; }
      let stdout = ''; let bytes = 0; let settled = false;
      let guardianPid: number | undefined; let guardianTicks: string | undefined; let handshake = '';
      let pendingTermination: Error | undefined;
      let cleanupPromise: Promise<void> | undefined;
      let completionHandled = false;
      const outputStreamsDrained = Promise.all([child.stdio[4], child.stdio[5]].map((stream) => new Promise<void>((resolve) => {
        stream?.once('end', resolve);
        stream?.once('close', resolve);
      })));
      const completeCommand = async (code: number | null) => {
        if (completionHandled || settled || pendingTermination) return;
        completionHandled = true;
        try { await stopAndClear(); }
        catch (error) { finish(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'could not confirm command process-group exit', context?.sessionId, error)); return; }
        if (pendingTermination || settled) return;
        if (code !== 0) return finish(new AgentRunnerError('COMMAND_FAILED', 'configured agent command failed'));
        try { const parsed = JSON.parse(stdout); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.protocol !== 'issue-orchestrator.agent-runner/v1') throw new Error(); finish(undefined, parsed); }
        catch { finish(new AgentRunnerError('COMMAND_PROTOCOL_ERROR', 'configured agent command returned an invalid protocol response')); }
      };
      const finish = (error?: Error, value?: ProtocolResponse) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value!); };
      const stopAndClear = () => cleanupPromise ??= (async () => {
        if (!guardianPid || !guardianTicks) throw new Error('missing guardian identity');
        await stopPersisted({ pid: guardianPid, pgid: guardianPid, startTicks: guardianTicks, token });
        let drainTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([outputStreamsDrained, new Promise<void>((_, reject) => {
            drainTimer = setTimeout(() => reject(new Error('agent output streams remained open after process-group cleanup')), 5000);
          })]);
        } finally { if (drainTimer) clearTimeout(drainTimer); }
        if (context && !this.storeProvider().clearAgentSessionProcess(context.sessionId, context.owner)) throw new Error('could not clear persisted process identity');
      })();
      const terminate = async (error: Error) => {
        pendingTermination = error;
        if (!guardianPid) { pendingTermination = error; child.stdin.end(); return; }
        try { await stopAndClear(); }
        catch (error) { finish(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'command process group could not be safely confirmed stopped', context?.sessionId, error)); return; }
        finish(error);
      };
      const timer = setTimeout(() => { void terminate(new AgentRunnerError('AGENT_TIMEOUT', 'configured agent command timed out')); }, Math.max(1, timeoutMs));
      child.stdout.on('data', (chunk: Buffer) => {
        // A timeout may win before the detached supervisor's identity
        // handshake arrives. Closing stdin makes it exit without a request;
        // never release the configured command after termination has begun.
        if (pendingTermination) { child.stdin.end(); return; }
        if (!guardianPid) {
          handshake += chunk.toString('utf8');
          const nl = handshake.indexOf('\n');
          if (nl < 0) return;
          try {
            if (handshake.slice(nl + 1).length > 0) throw new Error('unexpected guardian output after handshake');
            const hello = JSON.parse(handshake.slice(0, nl));
            if (hello.ready !== true || hello.pid !== child.pid) throw new Error();
            guardianPid = child.pid;
            guardianTicks = processInfo(guardianPid)?.start;
            if (!guardianTicks || !hasToken(guardianPid, token)) throw new Error();
            if (context && !this.storeProvider().recordAgentSessionProcess({ externalSessionId: context.sessionId, owner: context.owner, pid: guardianPid, pgid: guardianPid, startTicks: guardianTicks, token })) throw new Error();
            child.stdin.write(JSON.stringify({ token, socket, exe: this.options.executable, args: this.options.args ?? [], cwd: process.cwd(), env, request: JSON.stringify({ protocol: 'issue-orchestrator.agent-runner/v1', request_id: randomUUID(), ...request }) }));
            child.stdin.end();
          } catch { void terminate(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'command supervisor identity handshake failed')); }
          return;
        }
        void terminate(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'guardian emitted unexpected stdout'));
      });
      child.stdio[4]?.on('data', (chunk: Buffer) => {
        if (pendingTermination) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) void terminate(new AgentRunnerError('AGENT_OUTPUT_LIMIT', 'configured agent command exceeded output limit'));
        else stdout += chunk.toString('utf8');
      });
      child.stdio[5]?.on('data', () => {});
      let completionFrame = '';
      child.stdio[3]?.on('data', (chunk: Buffer) => {
        completionFrame += chunk.toString('utf8');
        const nl = completionFrame.indexOf('\n');
        if (nl < 0) return;
        try { const frame = JSON.parse(completionFrame.slice(0, nl)); if (!Number.isInteger(frame.code)) throw new Error(); void completeCommand(frame.code); }
        catch { finish(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'guardian completion frame was invalid', context?.sessionId)); }
      });
      child.on('error', () => finish(new AgentRunnerError('COMMAND_SPAWN_FAILED', 'configured agent command could not be started')));
      child.on('close', async (code) => {
        if (settled) return;
        if (!guardianPid) cleanupSocket(socket);
        if (pendingTermination) {
          try {
            if (guardianPid) await stopAndClear();
            else if (context && !this.storeProvider().clearAgentSessionProcess(context.sessionId, context.owner)) throw new Error();
          }
          catch { return finish(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'could not clear unstarted command launch identity', context?.sessionId)); }
          return finish(pendingTermination);
        }
        if (!guardianPid && context) {
          try { if (!this.storeProvider().clearAgentSessionProcess(context.sessionId, context.owner)) throw new Error(); }
          catch { return finish(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'could not clear command launch identity', context.sessionId)); }
        }
        if (guardianPid && !completionHandled) return finish(new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'guardian exited without a completion frame', context?.sessionId));
        if (!guardianPid) {
          if (code !== 0) return finish(new AgentRunnerError('COMMAND_FAILED', 'configured agent command failed'));
          try { const parsed = JSON.parse(stdout); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.protocol !== 'issue-orchestrator.agent-runner/v1') throw new Error(); finish(undefined, parsed); }
          catch { finish(new AgentRunnerError('COMMAND_PROTOCOL_ERROR', 'configured agent command returned an invalid protocol response')); }
        }
      });
    });
  }
}
