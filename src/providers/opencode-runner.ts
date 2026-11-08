import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  databasePath,
  type AgentUsage,
  type PersistedAgentProcess,
  type PersistedAgentSession,
  type SQLiteStore,
} from '../core/persistence.js';
import {
  cleanupOciContainers,
  prepareOciSandbox,
  writeOciShellWrapper,
  type OciSandbox,
} from './oci-sandbox.js';
import {
  descriptor,
  type AgentResult,
  type AgentRole,
  type AgentRunner,
  type AgentSession,
  type AgentSessionStatus,
  type AgentResultStatus,
  type CreateAgentSessionArgs,
  type RunAgentSessionArgs,
} from './ports.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 1000;
const EXECUTION_LEASE_MS = 60_000;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_NDJSON_BYTES = 50 * 1024 * 1024;
const MAX_STDERR_BYTES = 5 * 1024 * 1024;
const RESULT_RELATIVE_PATH = path.join('.issue-orchestrator', 'result.json');
const SUPPORTED_ROLES = new Set<AgentRole>(['triage', 'builder', 'verifier', 'reviewer']);

const ZERO_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

type FailureCode =
  | 'BUILDER_SECURITY_UNAVAILABLE'
  | 'INVALID_AGENT_SESSION'
  | 'INVALID_AGENT_RESULT'
  | 'AGENT_TIMEOUT'
  | 'AGENT_ABORTED'
  | 'AGENT_QUESTION_DENIED'
  | 'AGENT_OUTPUT_LIMIT'
  | 'AGENT_CLEANUP_FAILED'
  | 'AGENT_SESSION_BUSY'
  | 'AGENT_RECOVERY_UNSAFE'
  | 'AGENT_RECOVERY_FAILED'
  | 'AGENT_EXECUTION_LEASE_LOST'
  | 'AGENT_SPAWN_FAILED'
  | 'AGENT_PROCESS_FAILED';

export class AgentRunnerError extends Error {
  readonly code: FailureCode;
  readonly sessionId?: string;

  constructor(code: FailureCode, message: string, sessionId?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AgentRunnerError';
    this.code = code;
    this.sessionId = sessionId;
  }
}

export class AgentResultContractError extends AgentRunnerError {
  constructor(message: string, sessionId?: string, cause?: unknown) {
    super('INVALID_AGENT_RESULT', message, sessionId, cause);
    this.name = 'AgentResultContractError';
  }
}

interface RunnerOptions {
  executable?: string;
  store?: AgentSessionStore;
  storeProvider?: () => AgentSessionStore;
  timeoutMs?: number;
  terminationGraceMs?: number;
  /** Test seam. Production callers should use the process environment. */
  environment?: NodeJS.ProcessEnv;
  /** Test seam for a fake OCI CLI; production uses Docker or Podman from PATH. */
  containerRuntime?: string;
}

type AgentSessionStore = Pick<SQLiteStore,
  'createAgentSession' | 'getAgentSession' | 'claimAgentSession' | 'renewAgentSessionLease' |
  'recordAgentSessionLaunchIntent' | 'recordAgentSessionProcess' | 'clearAgentSessionProcess' |
  'completeAgentSession' | 'failAgentSession'>;

interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface ActiveRun {
  child: ChildProcess;
  closed: Promise<ProcessOutcome>;
  settled: Promise<void>;
  finishSettled: () => void;
  stopReason?: 'timeout' | 'abort' | 'question' | 'output' | 'lease-lost';
  leaseFailure?: AgentRunnerError;
  cleanupFailure?: AgentRunnerError;
  escalation?: NodeJS.Timeout;
  escalationDone?: Promise<void>;
  recoveryFailure?: AgentRunnerError;
  terminate: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentResultContractError(`result.json field "${field}" must be a non-empty string`);
  }
  return value;
}

/** Validate the only agent-authored success contract accepted by the runner. */
export function validateAgentResult(value: unknown): AgentResult {
  if (!isRecord(value)) throw new AgentResultContractError('result.json must contain a JSON object');
  const expected = [
    'status', 'summary', 'changed_files', 'commands', 'acceptance',
    'blocked_reason', 'evidence_dir', 'verdict',
  ];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== [...expected].sort()[index])) {
    throw new AgentResultContractError(`result.json must contain exactly: ${expected.join(', ')}`);
  }
  if (!['DONE', 'BLOCKED', 'CHANGES_REQUIRED'].includes(String(value.status))) {
    throw new AgentResultContractError('result.json status must be DONE, BLOCKED or CHANGES_REQUIRED');
  }
  const stringList = (field: string) => {
    const list = value[field];
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      throw new AgentResultContractError(`result.json field "${field}" must be an array of non-empty strings`);
    }
    return [...list] as string[];
  };
  const status = value.status as AgentResultStatus;
  const blockedReason = value.blocked_reason;
  if (blockedReason !== null && (typeof blockedReason !== 'string' || blockedReason.trim().length === 0)) {
    throw new AgentResultContractError('result.json field "blocked_reason" must be a non-empty string or null');
  }
  if (status === 'BLOCKED' && blockedReason === null) {
    throw new AgentResultContractError('BLOCKED result requires blocked_reason (put questions here; do not ask)');
  }
  if (status !== 'BLOCKED' && blockedReason !== null) {
    throw new AgentResultContractError('blocked_reason must be null unless status is BLOCKED');
  }
  const evidenceDir = value.evidence_dir;
  if (evidenceDir !== null && (typeof evidenceDir !== 'string' || evidenceDir.trim().length === 0)) {
    throw new AgentResultContractError('result.json field "evidence_dir" must be a non-empty string or null');
  }
  return {
    status,
    summary: requireNonEmptyString(value.summary, 'summary'),
    changed_files: stringList('changed_files'),
    commands: stringList('commands'),
    acceptance: stringList('acceptance'),
    blocked_reason: blockedReason as string | null,
    evidence_dir: evidenceDir as string | null,
    verdict: requireNonEmptyString(value.verdict, 'verdict'),
  };
}

function assertRole(role: string): asserts role is AgentRole {
  if (!SUPPORTED_ROLES.has(role as AgentRole)) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', `Unsupported agent role "${role}"`);
  }
}

function agentPermissions(role: AgentRole, worktree: string) {
  const denyAll = { action: '*', resource: '*', effect: 'deny' };
  const worktreeFiles = `${worktree}/**`;
  const resultFile = path.join(worktree, RESULT_RELATIVE_PATH);
  const permissions = [
    denyAll,
    { action: 'external_directory', resource: '*', effect: 'deny' },
    { action: 'external_directory', resource: worktree, effect: 'allow' },
    { action: 'external_directory', resource: worktreeFiles, effect: 'allow' },
    { action: 'read', resource: worktreeFiles, effect: 'allow' },
    { action: 'read', resource: '*.env', effect: 'deny' },
    { action: 'read', resource: '*.env.*', effect: 'deny' },
    { action: 'read', resource: `${worktree}/*.env.example`, effect: 'allow' },
    { action: 'read', resource: `${worktree}/**/*.env.example`, effect: 'allow' },
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'edit', resource: resultFile, effect: 'allow' },
    { action: 'question', resource: '*', effect: 'deny' },
  ];
  if (role !== 'builder') return [...permissions, { action: 'shell', resource: '*', effect: 'deny' }];
  return [
    ...permissions,
    { action: 'edit', resource: worktreeFiles, effect: 'allow' },
    { action: 'shell', resource: '*', effect: 'allow' },
    { action: 'shell', resource: '*git push*', effect: 'deny' },
    { action: 'shell', resource: '*gh*', effect: 'deny' },
    { action: 'shell', resource: '*glab*', effect: 'deny' },
  ];
}

function agentConfig(role: AgentRole, agentName: string, worktree: string, shellWrapper?: string) {
  const resultFile = path.join(worktree, RESULT_RELATIVE_PATH);
  const descriptions: Record<AgentRole, string> = {
    triage: 'Classify a trusted issue and identify acceptance criteria without editing files.',
    builder: 'Implement a change in the isolated workspace and report the structured result. Shell commands run in disposable network-disabled OCI containers.',
    verifier: 'Inspect the change read-only and report verification evidence without running commands or asking questions.',
    reviewer: 'Review the current change read-only and report findings without asking questions.',
  };
  const systems: Record<AgentRole, string> = {
    triage: `Triage only. Never ask a question. If required information is missing, return BLOCKED. Write the result contract to the absolute path ${JSON.stringify(resultFile)}.`,
    builder: `Implement only in the mounted workspace at /workspace. Every shell command is executed in a fresh, disposable OCI container with no network, no host home, no credentials, and no runtime socket. The shell starts in /workspace. Never push, use gh/glab, comment, merge, or ask questions. Write the result contract to the absolute path ${JSON.stringify(resultFile)}.`,
    verifier: `Verify only by read-only inspection. Do not edit or run shell commands. Never ask a question. Report blockers in the result file at ${JSON.stringify(resultFile)}.`,
    reviewer: `Review only. Do not edit or run shell commands. Never ask a question. Write the result contract to ${JSON.stringify(resultFile)}.`,
  };
  return {
    $schema: 'https://opencode.ai/config.json',
    plugins: [],
    mcp: {},
    ...(role === 'builder' && shellWrapper ? { shell: shellWrapper } : {}),
    agents: {
      [agentName]: {
        description: descriptions[role],
        mode: 'primary',
        system: systems[role],
        permissions: agentPermissions(role, worktree),
      },
    },
  };
}

function makeAgentPath(sourcePath: string | undefined, runDirectory: string) {
  const binDirectory = path.join(runDirectory, 'bin');
  fs.mkdirSync(binDirectory, { mode: 0o700 });
  const seen = new Set<string>();
  for (const rawDirectory of (sourcePath ?? '').split(path.delimiter)) {
    if (!rawDirectory) continue;
    let entries: string[];
    try { entries = fs.readdirSync(rawDirectory); } catch { continue; }
    for (const entry of entries) {
      const normalized = entry.toLowerCase();
      if ([
        'gh', 'gh.exe', 'gh.cmd', 'gh.bat',
        'glab', 'glab.exe', 'glab.cmd', 'glab.bat',
      ].includes(normalized) || seen.has(normalized)) continue;
      const candidate = path.join(rawDirectory, entry);
      try { fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); }
      catch { continue; }
      const destination = path.join(binDirectory, entry);
      try {
        fs.symlinkSync(candidate, destination);
      } catch {
        try {
          fs.copyFileSync(candidate, destination);
          if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
        } catch { continue; }
      }
      seen.add(normalized);
    }
  }
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  if (!seen.has(nodeName)) {
    const destination = path.join(binDirectory, nodeName);
    try { fs.symlinkSync(process.execPath, destination); }
    catch {
      try { fs.copyFileSync(process.execPath, destination); }
      catch { throw new AgentRunnerError('AGENT_PROCESS_FAILED', 'Could not add the trusted Node runtime to the isolated agent PATH'); }
    }
  }
  return binDirectory;
}

function scrubEnvironment(
  source: NodeJS.ProcessEnv,
  configFile: string,
  agentPath: string,
  privatePaths: { home: string; temp: string; xdgConfig: string; xdgCache: string; xdgState: string },
  executionId: string,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  const secretName = /(?:token|secret|password|passwd|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key|cookie)/i;
  const hostCredentialSource = /^(?:AWS|AZURE|GOOGLE|GCP|CLOUDSDK|KUBECONFIG|DOCKER|SSH|GIT_|GNUPG|GPG|NETRC|NPM_CONFIG_USERCONFIG|CREDENTIALS_DIRECTORY|DBUS_SESSION_BUS_ADDRESS$|XDG_RUNTIME_DIR$|KRB5|BOTO_CONFIG$|VAULT_|BW_|BITWARDEN_|OP_|PASS_|GCM_|GNOME_KEYRING_|BASH_ENV|ENV$|NODE_OPTIONS$|NODE_PATH$|LD_PRELOAD$|DYLD_)/i;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || secretName.test(key) || hostCredentialSource.test(key) ||
        /^(?:ISSUE_ORCHESTRATOR|GIT_ISSUE_AGENT)_/i.test(key) ||
        /^(?:GH|GITHUB|GITLAB|JIRA|AWS|AZURE|GOOGLE|GCP|SSH|OPENCODE)_/i.test(key) ||
        /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key) ||
        key === 'OPENCODE_CONFIG') continue;
    clean[key] = value;
  }
  // OpenCode is the trusted control plane and needs its persisted provider auth.
  // Agent tools remain constrained by the generated config; builder shell runs
  // in a separate container that receives neither these paths nor credentials.
  clean.HOME = source.HOME ?? os.homedir();
  clean.USERPROFILE = source.USERPROFILE ?? clean.HOME;
  clean.APPDATA = path.join(privatePaths.home, 'AppData', 'Roaming');
  clean.LOCALAPPDATA = path.join(privatePaths.home, 'AppData', 'Local');
  clean.XDG_CONFIG_HOME = privatePaths.xdgConfig;
  clean.XDG_CACHE_HOME = privatePaths.xdgCache;
  clean.XDG_STATE_HOME = privatePaths.xdgState;
  clean.TMPDIR = privatePaths.temp;
  clean.TMP = privatePaths.temp;
  clean.TEMP = privatePaths.temp;
  clean.OPENCODE_CONFIG = configFile;
  clean.PATH = agentPath;
  clean.GIT_TERMINAL_PROMPT = '0';
  clean.GIT_CONFIG_NOSYSTEM = '1';
  clean.ISSUE_ORCHESTRATOR_EXECUTION_ID = executionId;
  clean.NO_COLOR = '1';
  return clean;
}

function canonicalWorktree(candidate: string): string {
  let absolute: string;
  try {
    absolute = fs.realpathSync(candidate);
  } catch (error) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', `Worktree does not exist: ${candidate}`, undefined, error);
  }
  if (/[\\*?\n\r]/.test(absolute)) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', 'Worktree path contains characters unsafe for OpenCode permission rules');
  }
  const gitFile = path.join(absolute, '.git');
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(gitFile);
  } catch (error) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', 'Agent cwd must be an isolated Git worktree', undefined, error);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', 'Agent cwd must be a linked Git worktree, not the primary checkout');
  }
  const marker = fs.readFileSync(gitFile, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/i.exec(marker);
  if (!match) throw new AgentRunnerError('INVALID_AGENT_SESSION', 'Agent cwd has an invalid Git worktree marker');
  const gitDir = path.resolve(absolute, match[1]);
  if (!fs.existsSync(gitDir)) throw new AgentRunnerError('INVALID_AGENT_SESSION', 'Agent Git worktree metadata is missing');
  return absolute;
}

function ensureResultDirectory(worktree: string) {
  const root = path.join(worktree, '.issue-orchestrator');
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', '.issue-orchestrator must be a real directory inside the worktree');
  }
  return root;
}

function isOwnedByCurrentUser(stats: fs.Stats) {
  return process.platform === 'win32' || typeof process.getuid !== 'function' || stats.uid === process.getuid();
}

function ensurePrivateDirectory(directory: string) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', `Could not create private agent storage directory: ${directory}`, undefined, error);
  }
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', `Could not inspect agent storage directory: ${directory}`, undefined, error);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwnedByCurrentUser(stats)) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', `Agent storage path must be a real directory: ${directory}`);
  }
  try {
    fs.chmodSync(directory, 0o700);
    stats = fs.lstatSync(directory);
  } catch (error) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', `Could not secure agent storage directory: ${directory}`, undefined, error);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isOwnedByCurrentUser(stats) ||
      (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', `Agent storage directory is not private: ${directory}`);
  }
  try {
    return fs.realpathSync(directory);
  } catch (error) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', `Could not resolve agent storage directory: ${directory}`, undefined, error);
  }
}

function isWithin(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function ensureAgentSessionDirectory(worktree: string) {
  const candidate = path.resolve(path.dirname(databasePath()), 'agent-sessions');
  if (isWithin(worktree, candidate)) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', 'Agent session storage must be configured outside the agent-controlled worktree');
  }
  const sessionDirectory = ensurePrivateDirectory(candidate);
  if (isWithin(worktree, sessionDirectory)) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', 'Agent session storage must be outside the agent-controlled worktree');
  }
  return sessionDirectory;
}

function preparePrivateAgentDirectories(sessionDirectory: string) {
  const cwd = ensurePrivateDirectory(path.join(sessionDirectory, 'cwd'));
  const home = ensurePrivateDirectory(path.join(sessionDirectory, 'home'));
  const temp = ensurePrivateDirectory(path.join(sessionDirectory, 'tmp'));
  const xdgConfig = ensurePrivateDirectory(path.join(sessionDirectory, 'xdg-config'));
  const xdgCache = ensurePrivateDirectory(path.join(sessionDirectory, 'xdg-cache'));
  const xdgState = ensurePrivateDirectory(path.join(sessionDirectory, 'xdg-state'));
  ensurePrivateDirectory(path.join(home, 'AppData', 'Roaming'));
  ensurePrivateDirectory(path.join(home, 'AppData', 'Local'));
  return { cwd, home, temp, xdgConfig, xdgCache, xdgState };
}

function openSessionLog(file: string, resume: boolean) {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', 'This platform cannot safely open agent logs without following symlinks');
  }
  const baseFlags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NONBLOCK | noFollow;
  let fd: number;
  if (resume) {
    try {
      fd = fs.openSync(file, baseFlags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fd = fs.openSync(file, baseFlags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    }
  } else {
    fd = fs.openSync(file, baseFlags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  }
  try {
    let stats = fs.fstatSync(fd);
    if (!stats.isFile() || !isOwnedByCurrentUser(stats)) {
      throw new AgentRunnerError('INVALID_AGENT_SESSION', `Agent log is not an owned regular file: ${file}`);
    }
    fs.fchmodSync(fd, 0o600);
    stats = fs.fstatSync(fd);
    if (!stats.isFile() || !isOwnedByCurrentUser(stats) ||
        (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)) {
      throw new AgentRunnerError('INVALID_AGENT_SESSION', `Agent log is not a private regular file: ${file}`);
    }
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    throw error;
  }
}

function requireBuilderSandbox(worktree: string, runtime: string | undefined, environment: NodeJS.ProcessEnv, sessionId?: string) {
  try {
    return prepareOciSandbox(worktree, runtime, environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentRunnerError('BUILDER_SECURITY_UNAVAILABLE', `Builder OCI sandbox is unavailable: ${message}`, sessionId, error);
  }
}

function safeSessionPart(sessionId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new AgentRunnerError('INVALID_AGENT_SESSION', 'External session ID contains unsafe path characters', sessionId);
  }
  return sessionId;
}

function clearResultFile(worktree: string) {
  const file = path.join(worktree, RESULT_RELATIVE_PATH);
  try {
    const stats = fs.lstatSync(file);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new AgentResultContractError('result.json must be a regular file, not a symlink or directory');
    }
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readAgentResult(worktree: string, sessionId: string): AgentResult {
  const file = path.join(worktree, RESULT_RELATIVE_PATH);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    throw new AgentResultContractError('Agent did not write .issue-orchestrator/result.json', sessionId, error);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new AgentResultContractError('result.json must be a regular file', sessionId);
  }
  if (stats.size > MAX_RESULT_BYTES) {
    throw new AgentResultContractError(`result.json exceeds ${MAX_RESULT_BYTES} bytes`, sessionId);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AgentResultContractError('result.json is missing or invalid JSON', sessionId, error);
  }
  try {
    return validateAgentResult(parsed);
  } catch (error) {
    if (error instanceof AgentResultContractError) {
      throw new AgentResultContractError(error.message, sessionId, error);
    }
    throw error;
  }
}

function sessionValue(record: PersistedAgentSession): AgentSession {
  return {
    externalSessionId: record.externalSessionId,
    jobId: record.jobId,
    role: record.role as AgentRole,
    model: record.model,
    worktree: record.worktree,
    status: record.status as AgentSessionStatus,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

function finiteCount(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function finiteCost(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function addUsage(target: AgentUsage, event: unknown) {
  if (!isRecord(event) || event.type !== 'step_finish') return;
  const part = isRecord(event.part) ? event.part : event;
  const tokens = isRecord(part.tokens) ? part.tokens : isRecord(event.tokens) ? event.tokens : {};
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  target.inputTokens += finiteCount(tokens.input);
  target.outputTokens += finiteCount(tokens.output);
  target.reasoningTokens += finiteCount(tokens.reasoning);
  target.cacheReadTokens += finiteCount(cache.read);
  target.cacheWriteTokens += finiteCount(cache.write);
  target.costUsd += finiteCost(part.cost ?? event.cost);
}

function isQuestionToolEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (event.type !== 'tool_use' && event.type !== 'tool_call') return false;
  const part = isRecord(event.part) ? event.part : {};
  const input = isRecord(part.input) ? part.input : {};
  return [event.tool, event.name, part.tool, part.name, input.tool]
    .some((value) => typeof value === 'string' && value.toLowerCase() === 'question');
}

function resolveExecutable(executable: string) {
  if (path.isAbsolute(executable)) return executable;
  const searchPath = process.env.PATH ?? '';
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* continue */ }
  }
  // Leave normal PATH lookup to spawn so its error is returned without a shell.
  return executable;
}

const AGENT_SUPERVISOR_SOURCE = `import fs from 'node:fs';
import { spawn } from 'node:child_process';

let spec;
try {
  spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (typeof spec.executable !== 'string' || !Array.isArray(spec.argv) ||
      spec.argv.some((arg) => typeof arg !== 'string') || typeof spec.cwd !== 'string' ||
      !Number.isSafeInteger(spec.terminationGraceMs) || spec.terminationGraceMs < 0) {
    throw new Error('invalid agent launch specification');
  }
} catch (error) {
  process.stderr.write('Agent supervisor could not read its launch specification: ' + error.message + '\\n');
  process.exit(126);
}

let started = false;
let stopping = false;
let buffer = '';
function stopGroup() {
  if (stopping) return;
  stopping = true;
  try { process.kill(-process.pid, 'SIGTERM'); } catch { /* group may already be gone */ }
  setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { /* group already stopped */ }
  }, spec.terminationGraceMs);
}
function handleSignal() {
  if (!started) { process.exit(128); return; }
  stopGroup();
}
process.on('SIGTERM', handleSignal);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (started) { stopGroup(); return; }
  buffer += chunk;
  if (buffer.length > 64) { process.exit(126); return; }
  const newline = buffer.indexOf('\\n');
  if (newline < 0) return;
  if (buffer.slice(0, newline) !== 'START' || buffer.slice(newline + 1).trim() !== '') {
    process.exit(126);
    return;
  }
  started = true;
  buffer = '';
  let child;
  try {
    child = spawn(spec.executable, spec.argv, {
      cwd: spec.cwd, env: process.env, shell: false, detached: false,
      stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    });
  } catch (error) {
    process.stderr.write('Agent supervisor could not start OpenCode: ' + error.message + '\\n');
    process.exit(127);
  }
  let failedToSpawn = false;
  child.once('error', (error) => {
    failedToSpawn = true;
    process.stderr.write('Agent supervisor could not start OpenCode: ' + error.message + '\\n');
    process.exitCode = 127;
    process.exit();
  });
  child.once('close', (code, signal) => {
    if (failedToSpawn || stopping) return;
    process.exit(code ?? (signal ? 128 : 1));
  });
});
process.stdin.on('end', () => {
  // The parent only sends START after persisting this supervisor's identity.
  // EOF before that handoff means no agent or builder command may have run.
  if (!started) { process.exit(0); return; }
  stopGroup();
});
process.stdin.on('error', () => {
  if (!started) { process.exit(0); return; }
  stopGroup();
});
`;

function writeAgentLaunchFiles(directory: string, input: {
  executable: string;
  argv: string[];
  cwd: string;
  terminationGraceMs: number;
}) {
  const supervisorPath = path.join(directory, 'agent-supervisor.mjs');
  const specPath = path.join(directory, 'agent-launch.json');
  fs.writeFileSync(supervisorPath, AGENT_SUPERVISOR_SOURCE, { mode: 0o700, flag: 'wx' });
  fs.writeFileSync(specPath, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
  for (const [file, requiredMode] of [[supervisorPath, 0o700], [specPath, 0o600]] as const) {
    const stats = fs.lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink() ||
        (typeof process.getuid === 'function' && stats.uid !== process.getuid()) ||
        (stats.mode & 0o077) !== 0 || (stats.mode & 0o777) !== requiredMode) {
      throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Private agent launch files are not safely protected');
    }
  }
  return { supervisorPath, specPath };
}

interface ProcessInfo {
  pid: number;
  state: string;
  pgid: number;
  startIdentity: string;
}

function processHasExited(info: ProcessInfo | null) {
  return !info || info.state[0].toUpperCase() === 'Z' || info.state[0].toUpperCase() === 'X';
}

function linuxProcessInfo(pid: number): ProcessInfo | null {
  let stat: string;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null;
    throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Could not inspect process identity through /proc', undefined, error);
  }
  const end = stat.lastIndexOf(')');
  const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/);
  const pgid = Number(fields[2]);
  const startTicks = fields[19];
  if (!fields[0] || !Number.isSafeInteger(pgid) || !startTicks || !/^\d+$/.test(startTicks)) {
    throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Linux returned an invalid process identity');
  }
  return { pid, state: fields[0], pgid, startIdentity: startTicks };
}

function runMacPs(args: string[], operation: string, allowNoMatch = false) {
  const result = spawnSync('/bin/ps', args, {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    timeout: 2_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', `Could not ${operation} with macOS ps`, undefined, result.error);
  }
  const output = result.stdout ?? '';
  if (allowNoMatch && result.status === 1 && !output.trim()) return '';
  if (result.status !== 0) {
    throw new AgentRunnerError(
      'AGENT_RECOVERY_UNSAFE',
      `macOS ps could not ${operation}: ${(result.stderr ?? '').trim() || `exit ${String(result.status)}`}`,
    );
  }
  return output;
}

export function parseMacProcessLine(line: string): ProcessInfo {
  const fields = line.trim().split(/\s+/);
  if (fields.length !== 8) {
    throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'macOS ps returned an ambiguous process identity row');
  }
  const pid = Number(fields[0]);
  const pgid = Number(fields[1]);
  const [weekday, month, day, clock, year] = fields.slice(2, 7);
  const state = fields[7];
  const monthIndex = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(month);
  const [hour, minute, second] = clock.split(':').map(Number);
  const startDate = new Date(Date.UTC(Number(year), monthIndex, Number(day), hour, minute, second));
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || pgid <= 0 ||
      !/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(weekday) ||
      !/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(month) ||
      !/^(0?[1-9]|[12][0-9]|3[01])$/.test(day) ||
      !/^(?:[0-9]|[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(clock) || !/^\d{4}$/.test(year) ||
      monthIndex < 0 || startDate.getUTCFullYear() !== Number(year) ||
      startDate.getUTCMonth() !== monthIndex || startDate.getUTCDate() !== Number(day) ||
      !/^[A-Za-z][A-Za-z+<>*!?]*$/.test(state)) {
    throw new AgentRunnerError(
      'AGENT_RECOVERY_UNSAFE', `macOS ps returned an invalid process identity row: ${line.trim()}`,
    );
  }
  // `ps` may print a single-digit hour. Normalize it so the persisted identity
  // matches the strict format that recovery validation accepts later.
  const startIdentity = `${weekday} ${month} ${day.padStart(2, '0')} ` +
    `${clock.split(':')[0].padStart(2, '0')}:${clock.split(':')[1]}:${clock.split(':')[2]} ${year}`;
  return { pid, pgid, state, startIdentity };
}

function macProcessInfo(pid: number): ProcessInfo | null {
  const output = runMacPs(
    ['-p', String(pid), '-o', 'pid=,pgid=,lstart=,state='],
    `inspect process ${pid}`,
    true,
  );
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.length !== 1) {
    throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', `macOS ps returned multiple rows for PID ${pid}`);
  }
  const info = parseMacProcessLine(lines[0]);
  if (info.pid !== pid) throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'macOS ps returned a different PID than requested');
  return info;
}

function processInfo(pid: number): ProcessInfo | null {
  if (process.platform === 'linux') return linuxProcessInfo(pid);
  if (process.platform === 'darwin') return macProcessInfo(pid);
  throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Safe process identity is supported only on Linux and macOS');
}

function linuxProcessHasExecutionId(pid: number, executionId: string) {
  let environment: Buffer;
  try { environment = fs.readFileSync(`/proc/${pid}/environ`); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return false;
    // A process can exit between group enumeration and reading environ. Linux
    // may report EACCES for that newly-zombified /proc entry; re-check its
    // state before treating the inspection as unsafe.
    if (code === 'EACCES' && processHasExited(linuxProcessInfo(pid))) return false;
    throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Could not verify process execution identity', undefined, error);
  }
  const expected = Buffer.from(`ISSUE_ORCHESTRATOR_EXECUTION_ID=${executionId}`);
  return environment.toString('utf8').split('\0').some((entry) => entry === expected.toString('utf8'));
}

function macProcessHasExecutionId(pid: number, executionId: string) {
  const output = runMacPs(
    ['-E', '-ww', '-p', String(pid), '-o', 'command='],
    `inspect the execution token for PID ${pid}`,
    true,
  );
  if (!output) return false;
  const expected = `ISSUE_ORCHESTRATOR_EXECUTION_ID=${executionId}`;
  return output.split(/\s+/).some((entry) => entry === expected);
}

function processHasExecutionId(pid: number, executionId: string) {
  if (process.platform === 'linux') return linuxProcessHasExecutionId(pid, executionId);
  if (process.platform === 'darwin') return macProcessHasExecutionId(pid, executionId);
  throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Safe process identity is supported only on Linux and macOS');
}

async function waitForSpawnedProcessIdentity(pid: number, pgid: number, executionId: string) {
  const deadline = Date.now() + 1_000;
  do {
    const before = processInfo(pid);
    if (processHasExited(before)) return null;
    if (before.pgid !== pgid) {
      throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'New agent did not remain in its detached process group');
    }
    if (processHasExecutionId(pid, executionId)) {
      const confirmed = processInfo(pid);
      if (processHasExited(confirmed)) return null;
      if (confirmed.pgid !== pgid || confirmed.startIdentity !== before.startIdentity) {
        throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'New agent process identity changed during verification');
      }
      if (processHasExecutionId(pid, executionId)) return confirmed;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new AgentRunnerError(
    'AGENT_RECOVERY_UNSAFE',
    'Could not verify the new agent process start identity and execution token',
  );
}

function processGroupMembers(pgid: number) {
  if (process.platform === 'linux') {
    let entries: string[];
    try { entries = fs.readdirSync('/proc'); }
    catch (error) {
      throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Could not enumerate Linux processes for safe recovery', undefined, error);
    }
    const members: ProcessInfo[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const info = linuxProcessInfo(Number(entry));
      if (info?.pgid === pgid) members.push(info);
    }
    return members;
  }
  if (process.platform === 'darwin') {
    const output = runMacPs(
      ['-g', String(pgid), '-o', 'pid=,pgid=,lstart=,state='],
      `enumerate process group ${pgid}`,
      true,
    );
    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    const members = lines.map(parseMacProcessLine);
    if (members.some((member) => member.pgid !== pgid)) {
      throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'macOS ps returned a process outside the requested group');
    }
    return members;
  }
  throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Safe process identity is supported only on Linux and macOS');
}

function inspectPersistedProcessGroup(identity: PersistedAgentProcess) {
  const validStartIdentity = process.platform === 'linux'
    ? /^\d+$/.test(identity.startTicks ?? '')
    : /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (0[1-9]|[12][0-9]|3[01]) \d{2}:\d{2}:\d{2} \d{4}$/.test(identity.startTicks ?? '');
  if (!Number.isSafeInteger(identity.pid) || identity.pid! <= 0 ||
      !Number.isSafeInteger(identity.pgid) || identity.pgid! <= 0 ||
      !validStartIdentity || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.token ?? '') ||
      identity.pid !== identity.pgid) {
    throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'RUNNING session has no complete, safe child process identity');
  }
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Cannot safely recover a stale session without Linux /proc or macOS ps identity');
  }
  const leader = processInfo(identity.pid);
  if (leader && leader.startIdentity === identity.startTicks && leader.pgid !== identity.pgid) {
    throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Persisted process changed process group; refusing to signal it');
  }

  const members: number[] = [];
  for (const info of processGroupMembers(identity.pgid)) {
    const pid = info.pid;
    if (processHasExited(info)) continue;
    if (pid === identity.pid && info.startIdentity !== identity.startTicks) {
      throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'PID was reused; refusing to signal the unrelated process group');
    }
    if (!processHasExecutionId(pid, identity.token)) {
      const current = processInfo(pid);
      if (processHasExited(current) || current.pgid !== identity.pgid) continue;
      throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Process group identity does not match the persisted execution; refusing to signal it');
    }
    const current = processInfo(pid);
    if (processHasExited(current) || current.pgid !== identity.pgid) continue;
    if (current.startIdentity !== info.startIdentity) {
      throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'PID was reused; refusing to signal the unrelated process group');
    }
    if (pid === identity.pid && current.startIdentity !== identity.startTicks) {
      throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Persisted process start identity changed; refusing to signal it');
    }
    if (!processHasExecutionId(pid, identity.token)) {
      throw new AgentRunnerError('AGENT_RECOVERY_UNSAFE', 'Process execution token changed during identity verification; refusing to signal it');
    }
    members.push(pid);
  }
  return { active: members.length > 0, members };
}

function signalVerifiedProcessGroup(identity: PersistedAgentProcess, signal: NodeJS.Signals) {
  if (!inspectPersistedProcessGroup(identity).active) return false;
  try { process.kill(-identity.pgid!, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new AgentRunnerError('AGENT_RECOVERY_FAILED', `Could not send ${signal} to the verified process group`, undefined, error);
  }
  return true;
}

async function waitForPersistedGroupExit(identity: PersistedAgentProcess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!inspectPersistedProcessGroup(identity).active) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return !inspectPersistedProcessGroup(identity).active;
}

async function waitForSpawnedGroupExit(pgid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (processGroupMembers(pgid).every(processHasExited)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (true);
}

async function waitForProcessClose(closed: Promise<ProcessOutcome>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      closed,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalDirectChild(child: ChildProcess, signal: NodeJS.Signals) {
  // ChildProcess.kill targets only the process represented by this libuv handle;
  // unlike a PID/PGID kill it cannot address an unrelated process group.
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try { return child.kill(signal); }
  catch { return false; }
}

async function terminatePersistedProcessGroup(identity: PersistedAgentProcess, graceMs: number) {
  if (!signalVerifiedProcessGroup(identity, 'SIGTERM')) return;
  if (await waitForPersistedGroupExit(identity, graceMs)) return;
  // Revalidate identity immediately before escalating; never signal a reused PGID.
  if (!inspectPersistedProcessGroup(identity).active) return;
  signalVerifiedProcessGroup(identity, 'SIGKILL');
  if (!await waitForPersistedGroupExit(identity, 5000)) {
    throw new AgentRunnerError('AGENT_RECOVERY_FAILED', 'Persisted process group did not stop; refusing to launch another agent');
  }
}

function isToolEventLine(line: string, active: ActiveRun, onUsage: (event: unknown) => void) {
  let event: unknown;
  try { event = JSON.parse(line); } catch { return; }
  onUsage(event);
  if (isQuestionToolEvent(event) && !active.stopReason) {
    active.stopReason = 'question';
    active.terminate();
  }
}

export class OpenCodeAgentRunner implements AgentRunner {
  readonly name = 'opencode';
  readonly capabilities = descriptor('opencode', 'AgentRunner', {
    sessions: true,
    run: true,
    resume: true,
    abort: true,
    result: true,
    roles: Object.freeze(['triage', 'builder', 'verifier', 'reviewer']),
    blockedRoles: Object.freeze([]),
  }, []);

  private readonly executable: string;
  private readonly storeProvider: () => AgentSessionStore;
  private readonly timeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly containerRuntime?: string;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: RunnerOptions = {}) {
    this.executable = resolveExecutable(options.executable ?? 'opencode');
    if (options.store) this.storeProvider = () => options.store!;
    else if (options.storeProvider) this.storeProvider = options.storeProvider;
    else throw new Error('OpenCodeAgentRunner requires an AgentSessionStore provider');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.environment = options.environment ?? process.env;
    this.containerRuntime = options.containerRuntime;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
    if (!Number.isSafeInteger(this.terminationGraceMs) || this.terminationGraceMs < 0) {
      throw new Error('terminationGraceMs must be a non-negative integer');
    }
  }

  private store() {
    return this.storeProvider();
  }

  async createSession(args: CreateAgentSessionArgs): Promise<AgentSession> {
    assertRole(args.role);
    if (!Number.isSafeInteger(args.jobId) || args.jobId <= 0) {
      throw new AgentRunnerError('INVALID_AGENT_SESSION', 'createSession requires a positive persisted jobId');
    }
    if (!/^[^\s/]+\/[^\s/]+(?:#[^\s]+)?$/.test(args.model)) {
      throw new AgentRunnerError('INVALID_AGENT_SESSION', 'model must be provider/model with an optional #variant');
    }
    const worktree = canonicalWorktree(args.worktree);
    const externalSessionId = `ses_${randomUUID().replaceAll('-', '')}`;
    const safeId = safeSessionPart(externalSessionId);
    ensureResultDirectory(worktree);
    if (args.role === 'builder') {
      requireBuilderSandbox(worktree, this.containerRuntime, this.environment, externalSessionId);
    }
    const sessions = ensureAgentSessionDirectory(worktree);
    const sessionDirectory = ensurePrivateDirectory(path.join(sessions, safeId));
    ensurePrivateDirectory(path.join(sessionDirectory, 'cwd'));
    const record = this.store().createAgentSession({
      jobId: args.jobId,
      externalSessionId,
      role: args.role,
      model: args.model,
      worktree,
      ndjsonPath: path.join(sessionDirectory, 'events.ndjson'),
      stderrPath: path.join(sessionDirectory, 'stderr.log'),
    });
    return sessionValue(record);
  }

  run(args: RunAgentSessionArgs): Promise<AgentResult> {
    return this.execute(args, false);
  }

  resume(args: RunAgentSessionArgs): Promise<AgentResult> {
    return this.execute(args, true);
  }

  async abort(args: { sessionId: string }): Promise<boolean> {
    const active = this.activeRuns.get(args.sessionId);
    if (!active) return false;
    if (!active.stopReason) active.stopReason = 'abort';
    active.terminate();
    await active.settled;
    if (active.cleanupFailure) throw active.cleanupFailure;
    if (active.recoveryFailure) throw active.recoveryFailure;
    if (active.leaseFailure) throw active.leaseFailure;
    return true;
  }

  async getResult(args: { sessionId: string }): Promise<AgentResult | null> {
    const record = this.requireSession(args.sessionId);
    if (record.resultJson !== null) {
      let value: unknown;
      try { value = JSON.parse(record.resultJson); } catch (error) {
        throw new AgentResultContractError('Persisted result_json is invalid JSON', args.sessionId, error);
      }
      try { return validateAgentResult(value); } catch (error) {
        throw new AgentResultContractError('Persisted result_json violates the result contract', args.sessionId, error);
      }
    }
    if (['DONE', 'BLOCKED', 'CHANGES_REQUIRED'].includes(record.status)) {
      throw new AgentResultContractError('Completed session has no valid persisted result', args.sessionId);
    }
    if (record.status === 'FAILED' || record.status === 'ABORTED') {
      const failureCode = record.status === 'ABORTED'
        ? 'AGENT_ABORTED'
        : record.errorClass === 'AgentResultContractError' ? 'INVALID_AGENT_RESULT'
          : (record.errorClass && [
             'BUILDER_SECURITY_UNAVAILABLE', 'INVALID_AGENT_SESSION', 'INVALID_AGENT_RESULT',
             'AGENT_TIMEOUT', 'AGENT_ABORTED', 'AGENT_QUESTION_DENIED', 'AGENT_OUTPUT_LIMIT', 'AGENT_CLEANUP_FAILED',
             'AGENT_SESSION_BUSY', 'AGENT_RECOVERY_UNSAFE', 'AGENT_RECOVERY_FAILED', 'AGENT_EXECUTION_LEASE_LOST',
             'AGENT_SPAWN_FAILED', 'AGENT_PROCESS_FAILED',
          ].includes(record.errorClass) ? record.errorClass as FailureCode : 'AGENT_PROCESS_FAILED');
      throw new AgentRunnerError(
        failureCode,
        `Agent session ended with ${record.status}${record.errorClass ? ` (${record.errorClass})` : ''}`,
        args.sessionId,
      );
    }
    return null;
  }

  private requireSession(sessionId: string): PersistedAgentSession {
    if (!sessionId) throw new AgentRunnerError('INVALID_AGENT_SESSION', 'sessionId is required');
    const record = this.store().getAgentSession(sessionId);
    if (!record) throw new AgentRunnerError('INVALID_AGENT_SESSION', `Unknown agent session ${sessionId}`, sessionId);
    assertRole(record.role);
    return record;
  }

  private async execute(args: RunAgentSessionArgs, resume: boolean): Promise<AgentResult> {
    const record = this.requireSession(args.sessionId);
    if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
      throw new AgentRunnerError('INVALID_AGENT_SESSION', 'run requires a non-empty prompt', args.sessionId);
    }
    if (this.activeRuns.has(args.sessionId)) {
      throw new AgentRunnerError('AGENT_SESSION_BUSY', 'Agent session is already running in this runner', args.sessionId);
    }
    if (!resume && record.status === 'RUNNING') {
      throw new AgentRunnerError('AGENT_SESSION_BUSY', 'Agent session already has a persisted execution lease', args.sessionId);
    }
    if (!resume && record.status !== 'CREATED') {
      throw new AgentRunnerError('INVALID_AGENT_SESSION', `run requires CREATED status; found ${record.status}`, args.sessionId);
    }
    if (resume && record.status === 'DONE') {
      throw new AgentRunnerError('INVALID_AGENT_SESSION', 'A DONE agent session cannot be resumed', args.sessionId);
    }
    const timeoutMs = args.timeoutMs ?? this.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new AgentRunnerError('INVALID_AGENT_SESSION', 'timeoutMs must be a positive integer', args.sessionId);
    }
    const worktree = canonicalWorktree(record.worktree);
    const role = record.role as AgentRole;
    ensureResultDirectory(worktree);
    const sessions = ensureAgentSessionDirectory(worktree);
    const safeId = safeSessionPart(record.externalSessionId);
    const sessionDirectory = ensurePrivateDirectory(path.join(sessions, safeId));
    const privatePaths = preparePrivateAgentDirectories(sessionDirectory);
    const sandbox = role === 'builder'
      ? requireBuilderSandbox(worktree, this.containerRuntime, this.environment, record.externalSessionId)
      : undefined;
    const agentName = `issue-orchestrator-${role}-${safeId}`;
    if (path.resolve(record.ndjsonPath) !== path.join(sessionDirectory, 'events.ndjson') ||
        path.resolve(record.stderrPath) !== path.join(sessionDirectory, 'stderr.log')) {
      throw new AgentRunnerError('INVALID_AGENT_SESSION', 'Persisted agent output paths do not match this session', args.sessionId);
    }
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      throw new AgentRunnerError(
        'AGENT_RECOVERY_UNSAFE',
        'Durable process-group ownership requires Linux /proc or macOS ps identity; refusing to start an unrecoverable session',
        args.sessionId,
      );
    }

    const owner = randomUUID();
    const executionId = randomUUID();
    const leaseExpiry = () => new Date(Date.now() + EXECUTION_LEASE_MS).toISOString();
    const claim = this.store().claimAgentSession({
      externalSessionId: record.externalSessionId,
      owner,
      leaseUntil: leaseExpiry(),
      resume,
    });
    if (claim.acquired === false) {
      if (claim.reason === 'BUSY') {
        throw new AgentRunnerError('AGENT_SESSION_BUSY', 'Another runner owns the active agent execution lease', args.sessionId);
      }
      if (claim.reason === 'INVALID_LEASE') {
        throw new AgentRunnerError(
          'AGENT_RECOVERY_UNSAFE',
          'RUNNING session has no valid persisted lease; refusing to start a second process',
          args.sessionId,
        );
      }
      throw new AgentRunnerError(
        'INVALID_AGENT_SESSION',
        `Session cannot be started from persisted status ${claim.status}`,
        args.sessionId,
      );
    }

    let ndjsonFd: number | undefined;
    let stderrFd: number | undefined;
    let runDirectory: string | undefined;
    let configFile: string | undefined;
    let gitHooksDirectory: string | undefined;
    let sandboxCleanupError: AgentRunnerError | undefined;
    let recoveryError: AgentRunnerError | undefined;
    let leaseFailure: AgentRunnerError | undefined;
    let active: ActiveRun | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let spawnedPid: number | undefined;
    let spawnStartedAt: number | undefined;
    let executionProcess: PersistedAgentProcess | null = null;
    let processStopped = true;
    let previousExecutionReconciled = !claim.recovering;
    let containersCleaned = !sandbox;
    let closedOutcome: ProcessOutcome | undefined;
    const usage = { ...ZERO_USAGE };
    let ndjsonBytes = 0;
    let stderrBytes = 0;
    let pendingLine = '';
    let outputFailure: AgentRunnerError | undefined;

    const renewOwnership = () => {
      if (leaseFailure) return false;
      let renewed = false;
      try {
        renewed = this.store().renewAgentSessionLease(record.externalSessionId, owner, leaseExpiry());
      } catch { /* a persistence failure revokes this runner's authority */ }
      if (renewed) return true;
      leaseFailure = new AgentRunnerError(
        'AGENT_EXECUTION_LEASE_LOST',
        'Agent execution lease was lost; this runner will stop without changing terminal state',
        record.externalSessionId,
      );
      if (active) {
        active.leaseFailure = leaseFailure;
        if (!active.stopReason) active.stopReason = 'lease-lost';
        active.terminate();
      }
      return false;
    };

    const heartbeat = setInterval(() => { renewOwnership(); }, Math.floor(EXECUTION_LEASE_MS / 3));
    heartbeat.unref();

    const cleanupSandboxContainers = (executionScoped: boolean) => {
      if (!sandbox) {
        containersCleaned = true;
        return;
      }
      if (!renewOwnership()) throw leaseFailure;
      try {
        cleanupOciContainers(sandbox, record.externalSessionId, executionScoped ? executionId : undefined);
        containersCleaned = true;
      } catch (error) {
        const cleanupError = new AgentRunnerError(
          'AGENT_CLEANUP_FAILED',
          'Builder OCI containers could not be confirmed stopped and removed; session remains non-terminal',
          record.externalSessionId,
          error,
        );
        sandboxCleanupError = cleanupError;
        if (active) active.cleanupFailure = cleanupError;
        throw cleanupError;
      }
    };

    try {
      if (claim.recovering) {
        const previous = claim.previousProcess;
        if (!previous) {
          throw new AgentRunnerError(
            'AGENT_RECOVERY_UNSAFE',
            'Stale RUNNING session has no persisted child identity; refusing to launch another process',
            record.externalSessionId,
          );
        }
        const startupIntent = previous.pid === null && previous.pgid === null && previous.startTicks === null &&
          typeof previous.token === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previous.token);
        if (startupIntent) {
          // The supervisor cannot launch OpenCode until its identity is stored;
          // a token-only row therefore proves no agent or builder command ran.
          cleanupSandboxContainers(false);
        } else {
          await terminatePersistedProcessGroup(previous, this.terminationGraceMs);
          cleanupSandboxContainers(false);
        }
        if (!this.store().clearAgentSessionProcess(record.externalSessionId, owner)) {
          throw new AgentRunnerError('AGENT_EXECUTION_LEASE_LOST', 'Execution lease changed during stale-session recovery', record.externalSessionId);
        }
        previousExecutionReconciled = true;
      } else {
        cleanupSandboxContainers(false);
      }
      if (!renewOwnership()) throw leaseFailure;
      ndjsonFd = openSessionLog(record.ndjsonPath, resume);
      stderrFd = openSessionLog(record.stderrPath, resume);
      clearResultFile(worktree);
      runDirectory = fs.mkdtempSync(path.join(sessionDirectory, 'run-'));
      runDirectory = ensurePrivateDirectory(runDirectory);
      configFile = path.join(runDirectory, 'opencode.json');
      let shellWrapper: string | undefined;
      if (sandbox) {
        const generatedWrapper = writeOciShellWrapper(
          sandbox,
          record.externalSessionId,
          executionId,
          path.join(runDirectory, 'oci-shell.mjs'),
        );
        shellWrapper = generatedWrapper.file;
        gitHooksDirectory = generatedWrapper.gitHooksDirectory;
      }
      fs.writeFileSync(configFile, JSON.stringify(agentConfig(role, agentName, worktree, shellWrapper)), {
        mode: 0o600,
        flag: 'wx',
      });
      const resultFile = path.join(worktree, RESULT_RELATIVE_PATH);
      const prompt = [
        'Task from issue-orchestrator:',
        args.prompt.trim(),
        '',
        `Machine result contract: before finishing, write exactly one JSON object to the absolute path ${JSON.stringify(resultFile)} with required fields status (DONE, BLOCKED or CHANGES_REQUIRED), summary, changed_files (string[]), commands (string[]), acceptance (string[]), blocked_reason (string or null), evidence_dir (string or null), and verdict. For BLOCKED, put the concise question or blocker in blocked_reason. Never invoke a question tool.`,
      ].join('\n');
      const argv = [
        'run', '--standalone', '--session', record.externalSessionId,
        '--agent', agentName, '--model', record.model, '--format', 'json', '--auto', prompt,
      ];
      const agentPath = makeAgentPath(this.environment.PATH ?? this.environment.Path, runDirectory);
      const env = scrubEnvironment(this.environment, configFile, agentPath, privatePaths, executionId);
      const launchFiles = writeAgentLaunchFiles(runDirectory, {
        executable: this.executable,
        argv,
        cwd: privatePaths.cwd,
        terminationGraceMs: this.terminationGraceMs,
      });
      if (sandbox) containersCleaned = false;
      if (!this.store().recordAgentSessionLaunchIntent({
        externalSessionId: record.externalSessionId,
        owner,
        token: executionId,
      })) {
        throw new AgentRunnerError('AGENT_EXECUTION_LEASE_LOST', 'Could not persist agent launch intent', record.externalSessionId);
      }
      // The guardian waits for an explicit start message until its own process
      // identity is durably recorded. If this runner dies first, pipe EOF makes
      // it exit without ever starting OpenCode or a builder container.
      const child = spawn(process.execPath, [launchFiles.supervisorPath, launchFiles.specPath], {
        cwd: privatePaths.cwd,
        env,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      spawnStartedAt = Date.now();
      spawnedPid = child.pid;
      let spawnError: Error | undefined;
      const closed = new Promise<ProcessOutcome>((resolve) => {
        child.once('error', (error) => { spawnError = error; });
        child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
        child.once('error', (error) => resolve({ code: null, signal: null, error }));
      });
      let finishSettled!: () => void;
      const settled = new Promise<void>((resolve) => { finishSettled = resolve; });
      active = {
        child,
        closed,
        settled,
        finishSettled,
        terminate: () => {
          const signalActiveExecution = (signal: NodeJS.Signals) => {
            if (!executionProcess) {
              signalDirectChild(child, signal);
              return;
            }
            try {
              if (!signalVerifiedProcessGroup(executionProcess, signal)) signalDirectChild(child, signal);
            } catch (error) {
              recoveryError = error instanceof AgentRunnerError
                ? error
                : new AgentRunnerError('AGENT_RECOVERY_FAILED', 'Could not verify the active process group before signaling', record.externalSessionId, error);
              active!.recoveryFailure = recoveryError;
              // Group identity became untrustworthy. Fall back only to the
              // ChildProcess handle; never turn this into an unverified PGID kill.
              signalDirectChild(child, signal);
            }
          };
          if (active!.escalation) {
            // Identity may become verified while an abort/timeout is already
            // being handled. Extend TERM to the group only after verification.
            if (executionProcess) signalActiveExecution('SIGTERM');
            return;
          }
          signalActiveExecution('SIGTERM');
          active!.escalationDone = new Promise((resolve) => {
            active!.escalation = setTimeout(() => {
              signalActiveExecution('SIGKILL');
              resolve();
            }, this.terminationGraceMs);
          });
        },
      };
      this.activeRuns.set(record.externalSessionId, active);
      // The wall-clock budget starts as soon as spawn returns, before any
      // /proc or ps inspection can block or retry.
      timeout = setTimeout(() => {
        if (!active!.stopReason) active!.stopReason = 'timeout';
        active!.terminate();
      }, timeoutMs);
      timeout.unref();

      const onLine = (line: string) => isToolEventLine(line, active!, (event) => addUsage(usage, event));
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!renewOwnership()) return;
        ndjsonBytes += chunk.length;
        if (ndjsonBytes > MAX_NDJSON_BYTES) {
          outputFailure = new AgentRunnerError('AGENT_OUTPUT_LIMIT', 'OpenCode NDJSON output exceeded its size limit', record.externalSessionId);
          if (!active!.stopReason) {
            active!.stopReason = 'output';
            active!.terminate();
          }
          return;
        }
        try {
          fs.writeSync(ndjsonFd!, chunk);
          pendingLine += chunk.toString('utf8');
          const lines = pendingLine.split('\n');
          pendingLine = lines.pop() ?? '';
          for (const line of lines) onLine(line);
          if (pendingLine.length > 1024 * 1024) {
            outputFailure = new AgentRunnerError('AGENT_OUTPUT_LIMIT', 'OpenCode emitted an oversized NDJSON line', record.externalSessionId);
            if (!active!.stopReason) {
              active!.stopReason = 'output';
              active!.terminate();
            }
          }
        } catch (error) {
          outputFailure = new AgentRunnerError('AGENT_PROCESS_FAILED', 'Could not capture OpenCode NDJSON output', record.externalSessionId, error);
          if (!active!.stopReason) {
            active!.stopReason = 'output';
            active!.terminate();
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (!renewOwnership()) return;
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_STDERR_BYTES) {
          try { fs.writeSync(stderrFd!, chunk.subarray(0, Math.max(0, MAX_STDERR_BYTES - (stderrBytes - chunk.length)))); }
          catch { /* stderr capture is diagnostic only */ }
        }
      });

      if (child.pid) {
        processStopped = false;
        const confirmed = await waitForSpawnedProcessIdentity(child.pid, child.pid, executionId);
        if (!confirmed) {
          closedOutcome = await waitForProcessClose(closed, 5_000) ?? undefined;
          if (!closedOutcome) {
            throw new AgentRunnerError(
              'AGENT_RECOVERY_FAILED',
              'OpenCode exited during identity verification but could not be reaped',
              record.externalSessionId,
            );
          }
        } else {
          executionProcess = {
            pid: child.pid,
            pgid: confirmed.pgid,
            startTicks: confirmed.startIdentity,
            token: executionId,
          };
          if (active.stopReason) active.terminate();
          if (!this.store().recordAgentSessionProcess({
            externalSessionId: record.externalSessionId,
            owner,
            pid: executionProcess.pid!,
            pgid: executionProcess.pgid!,
            startTicks: executionProcess.startTicks!,
            token: executionProcess.token!,
          })) {
            renewOwnership();
            active.terminate();
            closedOutcome = await waitForProcessClose(closed, this.terminationGraceMs + 5_000) ?? undefined;
            if (active.escalationDone) await active.escalationDone;
            if (!closedOutcome) {
              recoveryError = new AgentRunnerError(
                'AGENT_RECOVERY_FAILED',
                'OpenCode did not exit after process ownership registration failed',
                record.externalSessionId,
              );
            }
            throw leaseFailure ?? new AgentRunnerError(
              'AGENT_EXECUTION_LEASE_LOST', 'Could not persist agent process ownership', record.externalSessionId,
            );
          }
          if (!renewOwnership()) throw leaseFailure;
          if (!active.stopReason) {
            const control = child.stdin;
            if (!control) throw new AgentRunnerError('AGENT_SPAWN_FAILED', 'Agent supervisor has no launch control pipe', record.externalSessionId);
            await new Promise<void>((resolve, reject) => {
              control.write('START\n', (error) => error ? reject(error) : resolve());
            });
          }
        }
      }

      const remainingBudget = Math.max(0, timeoutMs - (Date.now() - (spawnStartedAt ?? Date.now())));
      const outcome = closedOutcome ?? await waitForProcessClose(
        closed,
        remainingBudget + this.terminationGraceMs + 5_000,
      ) ?? (() => {
        recoveryError = new AgentRunnerError(
          'AGENT_RECOVERY_FAILED',
          'OpenCode did not exit after bounded TERM/KILL shutdown; refusing to release execution ownership',
          record.externalSessionId,
        );
        throw recoveryError;
      })();
      closedOutcome = outcome;
      if (timeout) clearTimeout(timeout);
      if (active.stopReason && active.escalationDone) await active.escalationDone;
      else if (active.escalation) clearTimeout(active.escalation);
      if (executionProcess) {
        await terminatePersistedProcessGroup(executionProcess, this.terminationGraceMs);
        processStopped = true;
      } else if (spawnedPid) {
        processStopped = await waitForSpawnedGroupExit(spawnedPid, 5_000);
        if (!processStopped) {
          throw new AgentRunnerError(
            'AGENT_RECOVERY_FAILED',
            'OpenCode process-group identity was not established and group shutdown cannot be proven; refusing to release execution ownership',
            record.externalSessionId,
          );
        }
      }
      cleanupSandboxContainers(true);
      if (!renewOwnership()) throw leaseFailure;
      // A final event without a trailing newline still decides the run: a
      // question tool must fail closed before any result is accepted.
      if (pendingLine.trim()) onLine(pendingLine);

      if (active.stopReason === 'timeout') {
        throw new AgentRunnerError('AGENT_TIMEOUT', `OpenCode exceeded the ${timeoutMs}ms wall-clock timeout`, record.externalSessionId);
      }
      if (active.stopReason === 'abort') {
        throw new AgentRunnerError('AGENT_ABORTED', 'OpenCode session was aborted', record.externalSessionId);
      }
      if (active.stopReason === 'question') {
        throw new AgentRunnerError('AGENT_QUESTION_DENIED', 'OpenCode attempted a question tool; the run was stopped', record.externalSessionId);
      }
      if (active.stopReason === 'lease-lost') throw leaseFailure;
      if (outputFailure) throw outputFailure;
      if (outcome.error) {
        throw new AgentRunnerError('AGENT_SPAWN_FAILED', `Could not start OpenCode: ${outcome.error.message}`, record.externalSessionId, outcome.error);
      }
      if (outcome.code !== 0) {
        throw new AgentRunnerError('AGENT_PROCESS_FAILED', `OpenCode exited with code ${String(outcome.code)}${outcome.signal ? ` (${outcome.signal})` : ''}`, record.externalSessionId);
      }

      const result = readAgentResult(worktree, record.externalSessionId);
      this.store().completeAgentSession({
        externalSessionId: record.externalSessionId,
        owner,
        status: result.status,
        result,
        usage,
      });
      return result;
    } catch (error) {
      let runnerError = error instanceof AgentRunnerError
        ? error
        : new AgentRunnerError('AGENT_PROCESS_FAILED', `OpenCode run failed: ${(error as Error).message}`, record.externalSessionId, error);
      if (active && !closedOutcome) {
        // Even before process identity is trusted, stop the direct spawned
        // process through its ChildProcess handle and bound both escalation
        // and reaping. Never fall back to signaling its unverified PGID.
        active.terminate();
        closedOutcome = await waitForProcessClose(
          active.closed,
          this.terminationGraceMs + 5_000,
        ) ?? undefined;
        if (active.escalationDone) await active.escalationDone;
        if (!closedOutcome) {
          recoveryError = new AgentRunnerError(
            'AGENT_RECOVERY_FAILED',
            'OpenCode direct child could not be reaped after bounded TERM/KILL shutdown',
            record.externalSessionId,
          );
        }
      }
      if (executionProcess && !processStopped) {
        try {
          await terminatePersistedProcessGroup(executionProcess, this.terminationGraceMs);
          processStopped = true;
        } catch (stopError) {
          recoveryError = stopError instanceof AgentRunnerError
            ? stopError
            : new AgentRunnerError('AGENT_RECOVERY_FAILED', 'Could not confirm the agent process group stopped', record.externalSessionId, stopError);
        }
      } else if (spawnedPid && !processStopped && closedOutcome) {
        try {
          processStopped = await waitForSpawnedGroupExit(spawnedPid, 5_000);
          if (!processStopped) {
            recoveryError = new AgentRunnerError(
              'AGENT_RECOVERY_FAILED',
              'OpenCode direct child stopped but the unverified process group may still be active; refusing replacement execution',
              record.externalSessionId,
            );
          }
        } catch (stopError) {
          recoveryError = stopError instanceof AgentRunnerError
            ? stopError
            : new AgentRunnerError('AGENT_RECOVERY_FAILED', 'Could not prove the unverified process group stopped', record.externalSessionId, stopError);
        }
      }
      if (!leaseFailure && previousExecutionReconciled && sandbox && !containersCleaned) {
        try { cleanupSandboxContainers(!!executionProcess); }
        catch { runnerError = sandboxCleanupError!; }
      }
      if (leaseFailure) runnerError = leaseFailure;
      else if (recoveryError) runnerError = recoveryError;
      else if (sandboxCleanupError) runnerError = sandboxCleanupError;

      const terminalSafe = previousExecutionReconciled && processStopped && containersCleaned &&
        !leaseFailure && !recoveryError && !sandboxCleanupError;
      if (terminalSafe) {
        try {
          this.store().failAgentSession({
            externalSessionId: record.externalSessionId,
            owner,
            status: active?.stopReason === 'abort' || runnerError.code === 'AGENT_ABORTED' ? 'ABORTED' : 'FAILED',
            errorClass: runnerError.name === 'AgentResultContractError' ? runnerError.name : runnerError.code,
            usage,
          });
        } catch (persistError) {
          runnerError = new AgentRunnerError(
            'AGENT_EXECUTION_LEASE_LOST',
            'Execution ownership changed before the failure could be persisted',
            record.externalSessionId,
            persistError,
          );
        }
      }
      throw runnerError;
    } finally {
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      if (active?.escalation) clearTimeout(active.escalation);
      if (active) {
        this.activeRuns.delete(record.externalSessionId);
        active.finishSettled();
      }
      if (ndjsonFd !== undefined) {
        try { fs.closeSync(ndjsonFd); } catch { /* already closed */ }
      }
      if (stderrFd !== undefined) {
        try { fs.closeSync(stderrFd); } catch { /* already closed */ }
      }
      if (runDirectory) {
        try { fs.rmSync(runDirectory, { recursive: true, force: true }); } catch { /* temporary policy config */ }
      }
      if (gitHooksDirectory) {
        try {
          fs.chmodSync(gitHooksDirectory, 0o700);
          fs.rmSync(gitHooksDirectory, { recursive: true, force: true });
        } catch { /* keep execution cleanup independent of temp-mask cleanup */ }
      }
    }
  }
}
