import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { databasePath } from './persistence.js';
import { DOD_CATEGORIES } from './config.js';

export const MAX_DOD_OUTPUT_BYTES = 32 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;

export type DodCategory = typeof DOD_CATEGORIES[number];
export type DodCommands = Record<DodCategory, string[] | null>;

export interface DodCommandResult {
  command: string[] | null;
  status: 'executed' | 'planned' | 'skipped';
  passed?: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  timeout_ms: number;
  stdout: string;
  stderr: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  output_limit_exceeded?: boolean;
  spawn_error?: string;
}

export interface DodReport {
  schema: 1;
  project: string;
  issue: number;
  head_sha: string;
  evidence_class: string;
  acceptance_source: string;
  acceptance_text: string;
  dod_config_sha256: string;
  commands: Record<DodCategory, DodCommandResult>;
  overall: 'passed' | 'failed' | 'planned';
  worktree_failure: string | null;
}

interface SpawnResult {
  error?: Error & { code?: string };
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function dodConfigHash(dod: unknown): string {
  return createHash('sha256').update(stableJson(dod)).digest('hex');
}

function boundedText(value: string | Buffer | null | undefined) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  return {
    text: buffer.subarray(0, MAX_DOD_OUTPUT_BYTES).toString('utf8'),
    truncated: buffer.length > MAX_DOD_OUTPUT_BYTES,
  };
}

export function executeDodCommands({
  project,
  issue,
  head,
  evidenceClass,
  acceptanceSource,
  acceptanceText,
  dod,
  cwd = process.cwd(),
  plan = false,
}: {
  project: string;
  issue: number;
  head: string;
  evidenceClass: string;
  acceptanceSource: string;
  acceptanceText: string;
  dod: { commands: DodCommands; timeout_ms?: number };
  cwd?: string;
  plan?: boolean;
}): DodReport {
  const timeoutMs = dod.timeout_ms ?? 300_000;
  const commands: Partial<Record<DodCategory, DodCommandResult>> = {};
  let failed = false;
  for (const category of DOD_CATEGORIES) {
    const argv = dod.commands[category];
    if (argv === null) {
      commands[category] = {
        command: null, status: 'skipped', exit_code: null, signal: null,
        timed_out: false, timeout_ms: timeoutMs, stdout: '', stderr: '',
      };
      continue;
    }
    if (plan) {
      commands[category] = {
        command: [...argv], status: 'planned', exit_code: null, signal: null,
        timed_out: false, timeout_ms: timeoutMs, stdout: '', stderr: '',
      };
      continue;
    }
    let result: SpawnResult;
    try {
      const spawned = spawnSync(argv[0], argv.slice(1), {
        shell: false,
        cwd,
        encoding: 'buffer',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_DOD_OUTPUT_BYTES,
        windowsHide: true,
      });
      result = {
        error: spawned.error,
        status: spawned.status,
        signal: spawned.signal,
        stdout: Buffer.isBuffer(spawned.stdout) ? spawned.stdout : Buffer.alloc(0),
        stderr: Buffer.isBuffer(spawned.stderr) ? spawned.stderr : Buffer.alloc(0),
      };
    } catch (error) {
      result = {
        error: error instanceof Error ? error as Error & { code?: string } : new Error(String(error)),
        status: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    }
    const stdout = boundedText(result.stdout);
    const stderr = boundedText(result.stderr);
    const timedOut = result.error?.code === 'ETIMEDOUT';
    const outputLimited = ['ENOBUFS', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(result.error?.code);
    const ok = result.status === 0 && !result.signal && !timedOut && !result.error && !outputLimited;
    failed ||= !ok;
    commands[category] = {
      command: [...argv],
      status: 'executed',
      passed: ok,
      exit_code: Number.isInteger(result.status) ? result.status : null,
      signal: result.signal ?? null,
      timed_out: timedOut,
      timeout_ms: timeoutMs,
      stdout: stdout.text,
      stderr: stderr.text,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      ...(outputLimited ? { output_limit_exceeded: true } : {}),
      ...(result.error ? { spawn_error: String(result.error.message ?? result.error) } : {}),
    };
  }
  return {
    schema: 1,
    project,
    issue: Number(issue),
    head_sha: head.toLowerCase(),
    evidence_class: evidenceClass,
    acceptance_source: acceptanceSource,
    acceptance_text: acceptanceText,
    dod_config_sha256: dodConfigHash(dod),
    commands: commands as Record<DodCategory, DodCommandResult>,
    overall: plan ? 'planned' : failed ? 'failed' : 'passed',
    worktree_failure: null as string | null,
  };
}

function privateReportDirectory() {
  const directory = path.join(path.dirname(databasePath()), 'dod-reports');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('DoD report directory must be an owned, real directory');
  }
  fs.chmodSync(directory, 0o700);
  return directory;
}

export function dodReportPath(project: string, issue: number, head: string) {
  const projectKey = createHash('sha256').update(project).digest('hex').slice(0, 16);
  return path.join(privateReportDirectory(), `${projectKey}-${issue}-${head.toLowerCase()}.json`);
}

function writePrivateJson(file: string, value: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > MAX_REPORT_BYTES) throw new Error('DoD report exceeds the 1 MB report limit');
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed or absent */ }
  }
}

export function saveDodReport(project: string, issue: number, head: string, report: unknown, extraPath?: string) {
  const internalPath = dodReportPath(project, issue, head);
  writePrivateJson(internalPath, report);
  if (extraPath) writePrivateJson(path.resolve(extraPath), report);
  return internalPath;
}

export function readDodReport(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES) {
    throw new Error('DoD report must be a regular file no larger than 1 MB');
  }
  let report;
  try { report = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('DoD report is not valid JSON'); }
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('DoD report must be a JSON object');
  return report;
}

export function validateDodReport(report: unknown, expected: {
  project: string;
  issue: number;
  head: string;
  evidenceClass: string;
  acceptanceSource: string;
  acceptanceText: string;
  dod: { commands: DodCommands; timeout_ms?: number };
}, { requirePassed = true } = {}) {
  const value = report as DodReport | null;
  if (!value || value.schema !== 1 || value.project !== expected.project ||
      Number(value.issue) !== Number(expected.issue) || value.head_sha !== expected.head.toLowerCase()) {
    return 'DoD report does not match the exact project, issue and head SHA';
  }
  if (value.evidence_class !== expected.evidenceClass) return 'DoD report evidence class does not match project configuration';
  if (value.acceptance_source !== expected.acceptanceSource || value.acceptance_text !== expected.acceptanceText) {
    return 'DoD report acceptance source/text is stale or does not match project configuration';
  }
  if (value.dod_config_sha256 !== dodConfigHash(expected.dod)) return 'DoD report is stale for the current project DoD configuration';
  if (requirePassed && (value.overall !== 'passed' || value.worktree_failure !== null)) {
    return 'DoD report is not a successful verification of an unchanged issue worktree';
  }
  if (!value.commands || typeof value.commands !== 'object' || Array.isArray(value.commands)) {
    return 'DoD report has no category results';
  }
  const expectedTimeout = expected.dod.timeout_ms ?? 300_000;
  for (const category of DOD_CATEGORIES) {
    const result = value.commands[category];
    const configured = expected.dod.commands[category];
    if (!result || typeof result !== 'object') return `DoD report is missing ${category} result`;
    if (configured === null) {
      if (result.status !== 'skipped' || result.command !== null || result.timeout_ms !== expectedTimeout ||
          result.exit_code !== null || result.signal !== null || result.timed_out !== false) {
        return `${category} must be explicitly skipped as configured`;
      }
    } else if (!Array.isArray(result.command) || JSON.stringify(result.command) !== JSON.stringify(configured)) {
      return `${category} report command does not match project configuration`;
    } else {
      if (result.timeout_ms !== expectedTimeout) return `${category} report timeout differs from project configuration`;
      if (requirePassed && (result.status !== 'executed' || result.passed !== true || result.exit_code !== 0 ||
          result.signal !== null || result.timed_out !== false || result.stdout_truncated === true ||
          result.stderr_truncated === true || result.output_limit_exceeded === true || result.spawn_error !== undefined ||
          typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_DOD_OUTPUT_BYTES ||
          typeof result.stderr !== 'string' || Buffer.byteLength(result.stderr) > MAX_DOD_OUTPUT_BYTES)) {
        return `${category} command was not executed successfully`;
      }
      if (!requirePassed && !['executed', 'planned'].includes(result.status)) {
        return `${category} has an invalid execution status`;
      }
    }
  }
  return null;
}
