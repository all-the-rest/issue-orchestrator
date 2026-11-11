import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import {
  assertWorkflowTransition,
  isTerminalWorkflowState,
  isWorkflowState,
  type WorkflowActor,
  type WorkflowState,
} from './state-machine.js';

const BUSY_TIMEOUT_MS = 5000;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const WAL_INIT_RETRY_MS = 30 * 1000;
const WAL_RETRY_WAIT_CELL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface Lock {
  provider: string;
  repo: string;
  issue: number;
  owner_token: string;
  config_file: string;
  branch?: string | null;
  account?: string | null;
  stage?: string;
  workflow_state?: WorkflowState;
  claimed_at?: string;
  updated_at?: string;
  local_only?: boolean;
  change_number?: number;
  head_sha?: string;
  evidence_commit?: string;
  release_result?: string;
  resumed_at?: string;
  lease_ms?: number;
}

type SqlRow = Record<string, SQLOutputValue>;

interface LegacyLock extends Record<string, unknown> {
  repo: string;
  issue: string | number;
  owner_token: string;
  provider?: string;
  config_file?: string;
  local_only?: boolean;
  claimed_at?: string;
  updated_at?: string;
  stage?: string;
  branch?: string | null;
  account?: string | null;
  change_number?: number | null;
  head_sha?: string | null;
  evidence_commit?: string | null;
  release_result?: string | null;
  resumed_at?: string | null;
}

interface LockRow extends SqlRow {
  provider: SQLOutputValue;
  project_id: SQLOutputValue;
  external_id: SQLOutputValue;
  branch: SQLOutputValue;
  account: SQLOutputValue;
  config_file: SQLOutputValue;
  owner_token: SQLOutputValue;
  stage: SQLOutputValue;
  claimed_at: SQLOutputValue;
  updated_at: SQLOutputValue;
  local_only: SQLOutputValue;
  change_number: SQLOutputValue;
  head_sha: SQLOutputValue;
  evidence_commit: SQLOutputValue;
  release_result: SQLOutputValue;
  resumed_at: SQLOutputValue;
}

interface MutationGuardRow extends SqlRow {
  owner_token: string;
  pid: number | bigint;
}

interface SchemaVersionRow extends SqlRow {
  version: number | bigint;
}

interface IdRow extends SqlRow {
  id: number | bigint;
}

interface RuntimeStateRow extends SqlRow {
  active_job_id: number | bigint | null;
  last_run: string | null;
}

interface JobTransitionRow extends IdRow {
  stage: string | null;
  state: string;
}

interface FinishingJobRow extends IdRow {
  work_item_id: number | bigint;
  project_id: string;
  provider: string;
  state: string;
  config_file: string | null;
}

interface EventWorkItemRow extends IdRow {
  state: string;
}

type EventIdRow = IdRow;

interface ClaimJobRow extends IdRow {
  project_id: string;
  work_item_id: number | bigint;
  provider: string;
  owner_token: string;
  claimed_by: string;
  claimed_at: string;
  heartbeat_at: string;
  lease_expires_at: string;
  attempts: number | bigint;
  max_attempts: number | bigint;
}

interface ExpiredJobRow extends IdRow {
  owner_token: string | null;
  work_item_id: number | bigint;
  state: string;
  attempts: number | bigint;
  max_attempts: number | bigint;
  claimed_by: string | null;
  project_id: string;
  provider: string;
  lease_pid: number | bigint | null;
  lease_start_ticks: string | null;
}

interface CountRow extends SqlRow {
  count: number | bigint;
}

interface EventStateRow extends SqlRow {
  id: number | bigint;
  state: string;
}

interface SideEffectRow extends SqlRow {
  idempotency_key: string;
  job_id: number | bigint | null;
  kind: string;
  intent_hash: string;
  intent_json: string;
  status: string;
  result_json: string | null;
}

interface AgentSessionRow extends SqlRow {
  id: number | bigint;
  job_id: number | bigint;
  session_id: string;
  external_session_id: string | null;
  runner_name: string | null;
  role: string | null;
  model: string | null;
  worktree: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  input_tokens: number | bigint;
  output_tokens: number | bigint;
  reasoning_tokens: number | bigint;
  cache_read_tokens: number | bigint;
  cache_write_tokens: number | bigint;
  cost_usd: number;
  result_json: string | null;
  ndjson_path: string | null;
  stderr_path: string | null;
  error_class: string | null;
  execution_owner: string | null;
  execution_lease_until: string | null;
  execution_pid: number | bigint | null;
  execution_pgid: number | bigint | null;
  execution_start_ticks: string | null;
  execution_token: string | null;
  oci_identity: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface PersistedAgentProcess {
  pid: number | null;
  pgid: number | null;
  startTicks: string | null;
  token: string | null;
}

export type AgentSessionClaim =
  | { acquired: true; recovering: boolean; previousProcess: PersistedAgentProcess | null }
  | { acquired: false; reason: 'BUSY' | 'INVALID_STATE' | 'INVALID_LEASE'; status: string };

export interface PersistedAgentSession {
  id: number;
  jobId: number;
  sessionId: string;
  externalSessionId: string;
  runner: string;
  role: string;
  model: string;
  worktree: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  resultJson: string | null;
  ndjsonPath: string;
  stderrPath: string;
  errorClass: string | null;
  executionOwner: string | null;
  executionLeaseUntil: string | null;
  executionPid: number | null;
  executionPgid: number | null;
  executionStartTicks: string | null;
  executionToken: string | null;
  ociIdentity: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RuntimeStateInput {
  active?: Lock | null;
  last_run?: string | null;
}

function asSqlRow<Row extends SqlRow>(row: SqlRow | undefined): Row | undefined {
  return row as unknown as Row | undefined;
}

function asSqlRows<Row extends SqlRow>(rows: SqlRow[]): Row[] {
  return rows as unknown as Row[];
}

export function databasePath() {
  const home = process.env.ISSUE_ORCHESTRATOR_HOME ?? process.env.GIT_ISSUE_AGENT_HOME;
  const runtimeHome = home ? path.resolve(home) : path.join(os.homedir(), '.config', 'issue-orchestrator');
  return path.join(runtimeHome, 'orchestrator.sqlite3');
}

function nowIso() {
  return new Date().toISOString();
}

function isGitHubTracker(provider: string): boolean {
  return provider.split('+', 1)[0] === 'github';
}

function githubProjectPredicate(column: string, provider: string): string {
  return isGitHubTracker(provider) ? `lower(${column})=lower(?)` : `${column}=?`;
}

function trackerProviderPredicate(alias: string, provider: string): string {
  const tracker = provider.split('+', 1)[0].replaceAll("'", "''");
  return `substr(${alias}.provider,1,instr(${alias}.provider||'+','+')-1)='${tracker}'`;
}

function sameTrackerProject(left: string, leftProvider: string, right: string, rightProvider: string): boolean {
  const leftTracker = leftProvider.split('+', 1)[0];
  const rightTracker = rightProvider.split('+', 1)[0];
  return leftTracker !== rightTracker ? false : isGitHubTracker(leftProvider)
    ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function processStartTicks(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closingParen = stat.lastIndexOf(')');
    if (closingParen < 0) return null;
    // The remainder begins at proc stat field 3; starttime is field 22.
    return stat.slice(closingParen + 1).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

const PROCESS_NAMESPACE = (() => {
  try {
    return `pid:${fs.readlinkSync('/proc/self/ns/pid')}`;
  } catch {
    // No PID namespaces (for example macOS) or an unreadable procfs. The host
    // name still separates distinct containers when procfs is unavailable.
    return `host:${os.hostname()}`;
  }
})();

function processOwnerAlive(pid: number, startTicks: unknown): boolean | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : true;
  }
  const currentStart = processStartTicks(pid);
  if (typeof startTicks === 'string' && currentStart !== null) return startTicks === currentStart;
  // On platforms without a process-start identity, a live PID is ambiguous;
  // fail closed instead of risking a lease theft after PID reuse.
  return true;
}

interface TicketOwnerRow extends SqlRow {
  id: string;
  state_json: SQLOutputValue;
  active_pid: number | bigint | null;
  active_start_ticks: string | null;
  active_namespace: string | null;
  active_lease_until: string | null;
  active_kind: string | null;
}

function ticketStateHasPendingBatch(stateJson: SQLOutputValue): boolean {
  try {
    const state = JSON.parse(String(stateJson)) as Record<string, unknown>;
    return !!state.pendingTurn ||
      (Array.isArray(state.deferredUpdates) && state.deferredUpdates.length > 0);
  } catch {
    return false;
  }
}

/**
 * A ticket handoff owner is alive only while its durable lease is valid. Same
 * namespace PID checks may shorten the wait after a crash; a foreign/unknown
 * PID namespace never authorizes early takeover, so a slow container cannot
 * lose ownership to a look-alike PID.
 */
function ticketOwnerAlive(row: TicketOwnerRow, nowMs = Date.now()): boolean {
  const lease = Date.parse(row.active_lease_until ?? '');
  if (Number.isFinite(lease) && lease > nowMs) {
    if (row.active_namespace === PROCESS_NAMESPACE && row.active_pid != null &&
        processOwnerAlive(Number(row.active_pid), row.active_start_ticks) === false) {
      return false;
    }
    return true;
  }
  if (row.active_lease_until) return false;
  // Legacy/ticket rows written before leases existed.
  if (row.active_pid == null) return false;
  const alive = processOwnerAlive(Number(row.active_pid), row.active_start_ticks);
  if (alive === false) return false;
  // Same namespace can trust a live PID. A foreign or unknown namespace without
  // a lease cannot be proven stale, so fail closed rather than stealing it.
  if (row.active_namespace === PROCESS_NAMESPACE) return alive === true;
  return true;
}

function assertResourceLocks(resources: string[] = []) {
  if (!Array.isArray(resources) || resources.some((name) => typeof name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) || new Set(resources).size !== resources.length) {
    throw new Error('resource_locks must contain unique safe resource names');
  }
}

function isSqliteBusy(error: unknown) {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & { errcode?: number };
  return sqliteError.errcode === 5 || sqliteError.errcode === 6 ||
    /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(error.message);
}

function enableWalWithRetry(db: DatabaseSync) {
  const deadline = Date.now() + WAL_INIT_RETRY_MS;
  let backoffMs = 10;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`SQLite stayed busy while enabling WAL after ${WAL_INIT_RETRY_MS}ms`, { cause: error });
      }
      const jitterMs = Math.floor(Math.random() * Math.max(1, Math.floor(backoffMs / 2)));
      Atomics.wait(WAL_RETRY_WAIT_CELL, 0, 0, Math.min(remainingMs, backoffMs + jitterMs));
      backoffMs = Math.min(backoffMs * 2, 250);
    }
  }
}

function hashPayload(payload: unknown) {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error('event payload must be JSON serializable');
  return createHash('sha256').update(serialized).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidLegacyLock(value: unknown): value is LegacyLock {
  if (!isRecord(value) || typeof value.repo !== 'string' || value.repo.length === 0 ||
      !Number.isSafeInteger(Number(value.issue)) || Number(value.issue) <= 0 ||
      typeof value.owner_token !== 'string' || value.owner_token.length === 0) return false;
  const optionalStrings = [
    'provider', 'config_file', 'claimed_at', 'updated_at', 'stage', 'account',
    'head_sha', 'evidence_commit', 'release_result', 'resumed_at',
  ];
  if (optionalStrings.some((key) => value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string')) return false;
  if (value.branch !== undefined && value.branch !== null && typeof value.branch !== 'string') return false;
  if (value.local_only !== undefined && typeof value.local_only !== 'boolean') return false;
  if (value.change_number !== undefined && value.change_number !== null && !Number.isSafeInteger(value.change_number)) return false;
  return true;
}

function legacyWorkflowState(stage?: string, result?: string): WorkflowState {
  const states: Record<string, WorkflowState> = {
    claimed: 'CLAIMED',
    triaged: 'CLAIMED',
    isolated: 'ISOLATED',
    'before-evidence': 'BEFORE_CAPTURED',
    implemented: 'IMPLEMENTED',
    'change-pending': 'IMPLEMENTED',
    'change-created': 'CHANGE_OPEN',
    'evidence-publishing': 'CHANGE_OPEN',
    'evidence-published': 'EVIDENCE_PUBLISHED',
    reviewed: 'REVIEWING',
    'checks-green': 'CHECKS_GREEN',
    'merge-pending': 'MERGING',
    merged: 'DONE',
    'release-pending': result === 'done' ? 'DONE' : result === 'blocked' ? 'BLOCKED' :
      result === 'review' ? 'REVIEW' : result === 'needs-info' ? 'NEEDS_INFO' : 'CLAIMED',
  };
  return states[stage ?? ''] ?? 'CLAIMED';
}

function fromRow(row: LockRow | undefined): Lock | null {
  if (!row) return null;
  if (typeof row.owner_token !== 'string') return null;
  return {
    provider: String(row.provider),
    repo: String(row.project_id),
    issue: Number(row.external_id),
    branch: typeof row.branch === 'string' ? row.branch : null,
    account: typeof row.account === 'string' ? row.account : null,
    config_file: typeof row.config_file === 'string' ? row.config_file : '',
    owner_token: row.owner_token,
    stage: typeof row.stage === 'string' ? row.stage : undefined,
    workflow_state: typeof row.workflow_state === 'string' && isWorkflowState(row.workflow_state)
      ? row.workflow_state
      : undefined,
    claimed_at: typeof row.claimed_at === 'string' ? row.claimed_at : undefined,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : undefined,
    local_only: !!row.local_only,
    change_number: row.change_number == null ? undefined : Number(row.change_number),
    head_sha: typeof row.head_sha === 'string' ? row.head_sha : undefined,
    evidence_commit: typeof row.evidence_commit === 'string' ? row.evidence_commit : undefined,
    release_result: typeof row.release_result === 'string' ? row.release_result : undefined,
    resumed_at: typeof row.resumed_at === 'string' ? row.resumed_at : undefined,
  };
}

const MIGRATIONS = [
  `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      config_file TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      local_only INTEGER NOT NULL DEFAULT 0,
      base_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE work_items (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      title TEXT,
      author TEXT,
      url TEXT,
      state TEXT NOT NULL DEFAULT 'READY',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, external_id)
    );
    CREATE INDEX work_items_queue ON work_items(state, created_at);

    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      work_item_id INTEGER REFERENCES work_items(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      delivery_id TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX events_delivery_identity
      ON events(provider, delivery_id) WHERE delivery_id IS NOT NULL;

    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      work_item_id INTEGER NOT NULL REFERENCES work_items(id),
      event_id INTEGER UNIQUE REFERENCES events(id) ON DELETE SET NULL,
      owner_token TEXT UNIQUE,
      config_file TEXT,
      provider TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'READY',
      stage TEXT,
      branch TEXT,
      account TEXT,
      local_only INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      claimed_at TEXT,
      heartbeat_at TEXT,
      lease_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      change_number INTEGER,
      head_sha TEXT,
      evidence_commit TEXT,
      release_result TEXT,
      resumed_at TEXT,
      error_class TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX jobs_ready_queue ON jobs(state, created_at);
    CREATE INDEX jobs_lease_expiry ON jobs(state, lease_expires_at);
    CREATE UNIQUE INDEX jobs_single_active_claim ON jobs((1))
      WHERE state IN ('CLAIMED', 'RUNNING');

    CREATE TABLE job_transitions (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      from_state TEXT,
      to_state TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX job_transitions_job ON job_transitions(job_id, created_at);

    CREATE TABLE agent_sessions (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      branch TEXT,
      base_sha TEXT,
      head_sha TEXT,
      change_number INTEGER,
      evidence_commit TEXT,
      error_class TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, session_id)
    );

    CREATE TABLE checks (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      head_sha TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      checked_at TEXT NOT NULL
    );

    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT,
      commit_sha TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE agent_servers (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      auth_ref TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE runtime_state (
      config_file TEXT PRIMARY KEY,
      active_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      last_run TEXT
    );

    CREATE TABLE legacy_imports (
      source_path TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL
    );

    CREATE TABLE mutation_guards (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner_token TEXT NOT NULL,
      pid INTEGER NOT NULL,
      acquired_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE jobs ADD COLUMN workflow_state TEXT NOT NULL DEFAULT 'NEW'
      CHECK (workflow_state IN (
        'NEW', 'TRIAGED', 'READY', 'CLAIMED', 'ISOLATED', 'BEFORE_CAPTURED',
        'IMPLEMENTING', 'IMPLEMENTED', 'CHANGE_OPEN', 'EVIDENCE_PUBLISHED',
        'REVIEWING', 'REVIEW_APPROVED', 'CHECKS_GREEN', 'MERGING', 'DONE',
        'NEEDS_INFO', 'BLOCKED', 'REVIEW', 'FAILED', 'CANCELLED', 'STALE'
      ));
    UPDATE jobs SET workflow_state = CASE
      WHEN stage = 'triaged' AND state IN ('CLAIMED', 'RUNNING') THEN 'CLAIMED'
      WHEN stage IN ('triaged') THEN 'TRIAGED'
      WHEN stage IN ('isolated') THEN 'ISOLATED'
      WHEN stage IN ('before-evidence') THEN 'BEFORE_CAPTURED'
      WHEN stage IN ('implemented', 'change-pending') THEN 'IMPLEMENTED'
      WHEN stage IN ('change-created', 'evidence-publishing') THEN 'CHANGE_OPEN'
      WHEN stage IN ('evidence-published') THEN 'EVIDENCE_PUBLISHED'
      WHEN stage IN ('reviewed') THEN 'REVIEWING'
      WHEN stage IN ('checks-green') THEN 'CHECKS_GREEN'
      WHEN stage IN ('merge-pending') THEN 'MERGING'
      WHEN stage IN ('merged') THEN 'DONE'
      WHEN stage IN ('release-pending') AND release_result = 'done' THEN 'DONE'
      WHEN stage IN ('release-pending') AND release_result = 'blocked' THEN 'BLOCKED'
      WHEN stage IN ('release-pending') AND release_result = 'review' THEN 'REVIEW'
      WHEN stage IN ('release-pending') AND release_result = 'needs-info' THEN 'NEEDS_INFO'
      WHEN state = 'FAILED' THEN 'FAILED'
      WHEN state = 'DONE' THEN 'DONE'
      WHEN state = 'BLOCKED' THEN 'BLOCKED'
      WHEN state = 'REVIEW' THEN 'REVIEW'
      WHEN state = 'NEEDS_INFO' THEN 'NEEDS_INFO'
      WHEN state = 'CANCELLED' THEN 'CANCELLED'
      WHEN state = 'STALE' THEN 'STALE'
      WHEN state IN ('CLAIMED', 'RUNNING') THEN 'CLAIMED'
      WHEN state = 'READY' THEN 'READY'
      WHEN state = 'ABANDONED' THEN 'STALE'
      ELSE 'NEW'
    END;

    CREATE TABLE workflow_transitions (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('cli', 'agent', 'human')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX workflow_transitions_job ON workflow_transitions(job_id, created_at);

    CREATE TABLE side_effect_journal (
      idempotency_key TEXT PRIMARY KEY,
      job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('INTENT', 'COMPLETED', 'UNCERTAIN')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX side_effect_journal_job ON side_effect_journal(job_id, created_at);
  `,
  `
    ALTER TABLE agent_sessions ADD COLUMN external_session_id TEXT;
    ALTER TABLE agent_sessions ADD COLUMN role TEXT;
    ALTER TABLE agent_sessions ADD COLUMN model TEXT;
    ALTER TABLE agent_sessions ADD COLUMN worktree TEXT;
    ALTER TABLE agent_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'FAILED';
    ALTER TABLE agent_sessions ADD COLUMN started_at TEXT;
    ALTER TABLE agent_sessions ADD COLUMN ended_at TEXT;
    ALTER TABLE agent_sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions ADD COLUMN result_json TEXT;
    ALTER TABLE agent_sessions ADD COLUMN ndjson_path TEXT;
    ALTER TABLE agent_sessions ADD COLUMN stderr_path TEXT;
    UPDATE agent_sessions SET external_session_id=session_id, started_at=created_at
      WHERE external_session_id IS NULL;
    CREATE INDEX agent_sessions_external_id ON agent_sessions(external_session_id);
    CREATE INDEX agent_sessions_job_role ON agent_sessions(job_id, role, created_at);
  `,
  `
    ALTER TABLE agent_sessions ADD COLUMN execution_owner TEXT;
    ALTER TABLE agent_sessions ADD COLUMN execution_lease_until TEXT;
    ALTER TABLE agent_sessions ADD COLUMN execution_pid INTEGER;
    ALTER TABLE agent_sessions ADD COLUMN execution_pgid INTEGER;
    ALTER TABLE agent_sessions ADD COLUMN execution_start_ticks TEXT;
    ALTER TABLE agent_sessions ADD COLUMN execution_token TEXT;
    CREATE INDEX agent_sessions_execution_owner ON agent_sessions(execution_owner, execution_lease_until);
  `,
  `
    DROP INDEX IF EXISTS jobs_single_active_claim;
    CREATE TABLE IF NOT EXISTS job_resource_locks (
      resource TEXT PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      owner_token TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduler_config (
      config_file TEXT PRIMARY KEY,
      max_concurrency INTEGER NOT NULL CHECK(max_concurrency > 0)
    );
    CREATE TABLE IF NOT EXISTS scheduler_project_caps (
      config_file TEXT NOT NULL,
      project_id TEXT NOT NULL,
      max_concurrency INTEGER NOT NULL CHECK(max_concurrency > 0),
      PRIMARY KEY(config_file, project_id)
    );
    CREATE TABLE IF NOT EXISTS scheduler_global_limit (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      max_concurrency INTEGER NOT NULL CHECK(max_concurrency > 0)
    );
    CREATE TABLE IF NOT EXISTS scheduler_project_limit (
      project_id TEXT PRIMARY KEY,
      max_concurrency INTEGER NOT NULL CHECK(max_concurrency > 0)
    );
    INSERT OR IGNORE INTO scheduler_config(config_file,max_concurrency)
      SELECT DISTINCT config_file,1 FROM jobs WHERE config_file IS NOT NULL AND state IN ('CLAIMED','RUNNING');
    ALTER TABLE jobs ADD COLUMN lease_pid INTEGER;
    UPDATE jobs SET lease_pid=CAST(claimed_by AS INTEGER)
      WHERE state IN ('CLAIMED','RUNNING') AND claimed_by GLOB '[0-9]*';
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_owner_per_work_item
      ON jobs(work_item_id) WHERE state IN ('CLAIMED','RUNNING');
  `,
  `
    ALTER TABLE jobs ADD COLUMN lease_start_ticks TEXT;
  `,
  `
    ALTER TABLE agent_sessions ADD COLUMN oci_identity TEXT;
  `,
  `
    ALTER TABLE agent_sessions ADD COLUMN runner_name TEXT NOT NULL DEFAULT 'opencode';
    CREATE TABLE ticket_handoffs (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      issue INTEGER NOT NULL CHECK(issue > 0),
      goal_hash TEXT NOT NULL,
      goal_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project, issue, goal_hash)
    );
    CREATE INDEX ticket_handoffs_issue ON ticket_handoffs(project, issue, created_at);
  `,
  `
    ALTER TABLE ticket_handoffs ADD COLUMN active_owner TEXT;
    ALTER TABLE ticket_handoffs ADD COLUMN active_pid INTEGER;
    ALTER TABLE ticket_handoffs ADD COLUMN active_start_ticks TEXT;
  `,
  `
    ALTER TABLE ticket_handoffs ADD COLUMN active_lease_until TEXT;
    ALTER TABLE ticket_handoffs ADD COLUMN active_heartbeat_at TEXT;
    ALTER TABLE ticket_handoffs ADD COLUMN active_namespace TEXT;
    ALTER TABLE ticket_handoffs ADD COLUMN active_kind TEXT
      CHECK (active_kind IS NULL OR active_kind IN ('session', 'intake'));
    UPDATE ticket_handoffs SET active_kind='session' WHERE active_owner IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ticket_scheduler_global_limit (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      max_concurrency INTEGER NOT NULL CHECK(max_concurrency > 0)
    );
    -- Existing active ticket handoffs get one bounded grace lease instead of
    -- becoming immortal or being mistaken for a reclaimable look-alike PID.
    UPDATE ticket_handoffs
      SET active_lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes')
      WHERE active_owner IS NOT NULL AND active_lease_until IS NULL;
  `,
  `
    CREATE TABLE IF NOT EXISTS ticket_delivery_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      cooldown_ms INTEGER NOT NULL CHECK(cooldown_ms >= 0),
      last_started_ms INTEGER
    );
  `,
];

export interface TicketHandoffRecord {
  id: string;
  project: string;
  issue: number;
  goalHash: string;
  goal: string;
  state: Record<string, unknown>;
}

export type TicketHandoffClaim =
  | { acquired: true }
  | { acquired: false; reason: 'BUSY' | 'CAPACITY' | 'CONFIG_MISMATCH'; activeCount?: number };

export const DEFAULT_TICKET_LEASE_MS = 60 * 1000;

export class SQLiteStore {
  readonly db: DatabaseSync;

  constructor(file = databasePath()) {
    const absolute = path.resolve(file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(absolute);
    try {
      try { fs.chmodSync(absolute, 0o600); } catch { /* best effort on non-POSIX hosts */ }
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      this.db.exec('PRAGMA foreign_keys = ON');
      enableWalWithRetry(this.db);
      this.db.exec('PRAGMA synchronous = FULL');
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  /** Get or atomically create durable ticket handoff state for a workflow key. */
  getOrCreateTicketHandoff(input: Omit<TicketHandoffRecord, 'id'> & { id: string }): TicketHandoffRecord {
    return this.transaction(() => {
      // GitHub project ids are case-insensitive; one issue must never get two
      // worktree owners merely because a poller spelled the repository differently.
      const rows = this.db.prepare(
        'SELECT id,goal_hash,goal_json,state_json FROM ticket_handoffs WHERE lower(project)=lower(?) AND issue=? ORDER BY updated_at DESC,created_at DESC',
      ).all(input.project, input.issue) as Array<{ id: string; goal_hash: string; goal_json: string; state_json: string }>;
      const existing = rows.find((row) => row.goal_hash === input.goalHash);
      if (existing) {
        if (existing.goal_json !== JSON.stringify(input.goal)) {
          throw new Error('persisted ticket goal does not match its digest');
        }
        return { ...input, id: existing.id, goalHash: existing.goal_hash,
          goal: JSON.parse(existing.goal_json) as string,
          state: JSON.parse(existing.state_json) as Record<string, unknown> };
      }
      // A ticket shares one worktree across workflows. Never start a goal and a
      // route-only handoff on the same issue concurrently.
      const active = rows.find((row) => {
        const state = JSON.parse(row.state_json) as Record<string, unknown>;
        return !state.terminal;
      });
      if (active) throw new Error('ticket already has an active handoff with a different goal');
      const now = nowIso();
      this.db.prepare('INSERT INTO ticket_handoffs(id,project,issue,goal_hash,goal_json,state_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(input.id, input.project, input.issue, input.goalHash, JSON.stringify(input.goal), JSON.stringify(input.state), now, now);
      return input;
    });
  }

  readTicketHandoff(id: string): TicketHandoffRecord | null {
    const row = asSqlRow<{ id: string; project: string; issue: number; goal_hash: string; goal_json: string; state_json: string }>(
      this.db.prepare('SELECT id,project,issue,goal_hash,goal_json,state_json FROM ticket_handoffs WHERE id=?').get(id));
    return row ? { id: row.id, project: row.project, issue: Number(row.issue), goalHash: row.goal_hash, goal: JSON.parse(row.goal_json) as string, state: JSON.parse(row.state_json) as Record<string, unknown> } : null;
  }

  /**
   * List persisted ticket handoffs, newest first. Pollers use this to keep
   * draining known associations after the GitHub issue itself closes, when the
   * open-issue listing no longer returns it. Read-only: no migration or write.
   */
  listTicketHandoffs(project?: string, limit = 1000): Array<TicketHandoffRecord & { updatedAt: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
      throw new Error('ticket handoff list limit must be an integer from 1 to 5000');
    }
    type Row = { id: string; project: string; issue: number; goal_hash: string; goal_json: string; state_json: string;
      updated_at: string };
    const rows = asSqlRows<Row>(project
      ? this.db.prepare(`SELECT id,project,issue,goal_hash,goal_json,state_json,updated_at
          FROM ticket_handoffs WHERE lower(project)=lower(?) ORDER BY updated_at DESC, created_at DESC LIMIT ?`)
        .all(project, limit)
      : this.db.prepare(`SELECT id,project,issue,goal_hash,goal_json,state_json,updated_at
          FROM ticket_handoffs ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(limit));
    return rows.map((row) => ({
      id: row.id, project: row.project, issue: Number(row.issue), goalHash: row.goal_hash,
      goal: JSON.parse(row.goal_json) as string, state: JSON.parse(row.state_json) as Record<string, unknown>,
      updatedAt: row.updated_at,
    }));
  }

  /** Persist state; with an owner this is a compare-and-swap against a stolen lease. */
  updateTicketHandoff(id: string, state: Record<string, unknown>, owner?: string): void {
    this.transaction(() => {
      const result = owner
        ? this.db.prepare('UPDATE ticket_handoffs SET state_json=?,updated_at=? WHERE id=? AND active_owner=?')
          .run(JSON.stringify(state), nowIso(), id, owner)
        : this.db.prepare('UPDATE ticket_handoffs SET state_json=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(state), nowIso(), id);
      if (Number(result.changes) !== 1) {
        throw new Error(owner
          ? 'ticket handoff ownership was lost; refusing to overwrite newer state'
          : 'ticket handoff not found');
      }
    });
  }

  /** Claim one ticket handoff so concurrent CLI retries cannot duplicate its external effects. */
  claimTicketHandoff(id: string, owner: string): boolean {
    return this.tryClaimTicketHandoff(id, owner).acquired;
  }

  /**
   * Atomically claim one ticket handoff and, optionally, one global session
   * slot. Dead owners are ignored so a restart can reclaim their slot.
   */
  tryClaimTicketHandoff(id: string, owner: string,
    options: { maxConcurrency?: number; leaseMs?: number; kind?: 'session' | 'intake' } = {}): TicketHandoffClaim {
    if (!id || !owner) throw new Error('ticket handoff claim requires an id and owner');
    const maxConcurrency = options.maxConcurrency;
    const leaseMs = options.leaseMs ?? DEFAULT_TICKET_LEASE_MS;
    const kind = options.kind ?? 'session';
    if (kind !== 'session' && kind !== 'intake') throw new Error('invalid ticket claim kind');
    if (maxConcurrency !== undefined &&
        (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1)) {
      throw new Error('ticket session max_concurrency must be a positive integer');
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('ticket lease must be a positive integer');
    return this.transaction(() => {
      const row = asSqlRow<TicketOwnerRow & { project: string; issue: number | bigint; active_owner: string | null }>(
        this.db.prepare(`SELECT id,project,issue,active_owner,state_json,active_pid,active_start_ticks,
          active_namespace,active_lease_until,active_kind FROM ticket_handoffs WHERE id=?`).get(id));
      if (!row) return { acquired: false, reason: 'BUSY' };
      // Goal and route-only handoffs may exist from different workflow keys but
      // share the issue worktree; only one may execute at a time. A durable
      // pending batch in either workflow also owns the issue. GitHub project ids
      // are case-insensitive, so aliases must not open a second worktree.
      const others = this.db.prepare(`SELECT id,state_json,active_pid,active_start_ticks,active_namespace,active_lease_until,active_kind
        FROM ticket_handoffs WHERE lower(project)=lower(?) AND issue=? AND id<>?`)
        .all(row.project, row.issue, id) as unknown as TicketOwnerRow[];
      if (others.some((other) => ticketOwnerAlive(other) || ticketStateHasPendingBatch(other.state_json))) {
        return { acquired: false, reason: 'BUSY' };
      }
      if (row.active_owner && row.active_owner !== owner && ticketOwnerAlive(row)) {
        return { acquired: false, reason: 'BUSY' };
      }
      if (maxConcurrency !== undefined) {
        const handoffs = this.db.prepare(`SELECT id,state_json,active_pid,active_start_ticks,active_namespace,active_lease_until,active_kind
          FROM ticket_handoffs WHERE id<>?`).all(id) as unknown as TicketOwnerRow[];
        const logicalActive = handoffs.filter((other) =>
          ticketOwnerAlive(other) || ticketStateHasPendingBatch(other.state_json)).length;
        const stored = asSqlRow<SqlRow>(
          this.db.prepare('SELECT max_concurrency FROM ticket_scheduler_global_limit WHERE singleton=1').get());
        if (stored && Number(stored.max_concurrency) !== maxConcurrency) {
          // Conflicting pollers must not each enforce their own private cap.
          if (logicalActive > 0) {
            return { acquired: false, reason: 'CONFIG_MISMATCH', activeCount: logicalActive };
          }
          this.db.prepare('UPDATE ticket_scheduler_global_limit SET max_concurrency=? WHERE singleton=1')
            .run(maxConcurrency);
        } else if (!stored) {
          this.db.prepare('INSERT INTO ticket_scheduler_global_limit(singleton,max_concurrency) VALUES (1,?)')
            .run(maxConcurrency);
        }
        // Intake claims are short observation locks, not agent sessions; they
        // must never consume one of the configured global session slots.
        const activeCount = handoffs.filter((other) =>
          other.active_kind !== 'intake' && ticketOwnerAlive(other)).length;
        if (activeCount >= maxConcurrency) return { acquired: false, reason: 'CAPACITY', activeCount };
      }
      const now = Date.now();
      const result = this.db.prepare(`
        UPDATE ticket_handoffs SET active_owner=?,active_pid=?,active_start_ticks=?,active_namespace=?,
          active_heartbeat_at=?,active_lease_until=?,active_kind=?,updated_at=?
        WHERE id=? AND active_owner IS ? AND active_pid IS ? AND active_start_ticks IS ?
      `).run(owner, process.pid, processStartTicks(process.pid), PROCESS_NAMESPACE,
        new Date(now).toISOString(), new Date(now + leaseMs).toISOString(), kind, nowIso(), id,
        row.active_owner, row.active_pid ?? null, row.active_start_ticks ?? null);
      return Number(result.changes) === 1 ? { acquired: true } : { acquired: false, reason: 'BUSY' };
    });
  }

  /** Renew one owner's durable ticket lease; a lost/foreign owner cannot renew. */
  heartbeatTicketHandoff(id: string, owner: string, leaseMs = DEFAULT_TICKET_LEASE_MS): boolean {
    if (!id || !owner) throw new Error('ticket heartbeat requires an id and owner');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('ticket lease must be a positive integer');
    const now = Date.now();
    const result = this.db.prepare(`UPDATE ticket_handoffs SET active_heartbeat_at=?,active_lease_until=?,updated_at=?
      WHERE id=? AND active_owner=?`).run(new Date(now).toISOString(),
      new Date(now + leaseMs).toISOString(), nowIso(), id, owner);
    return Number(result.changes) === 1;
  }

  /**
   * Read the durable global dispatch cooldown anchor. When `cooldownMs` is
   * supplied, a stored value from another poller must match exactly; otherwise
   * this fails closed instead of letting pollers enforce private limits.
   */
  readTicketDispatchStart(cooldownMs?: number): number | null {
    if (cooldownMs !== undefined && (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0)) {
      throw new Error('ticket delivery cooldown must be a non-negative integer');
    }
    const row = asSqlRow<SqlRow>(this.db.prepare(
      'SELECT cooldown_ms,last_started_ms FROM ticket_delivery_state WHERE singleton=1').get());
    if (!row) return null;
    if (cooldownMs !== undefined && Number(row.cooldown_ms) !== cooldownMs) {
      throw new Error('ticket delivery cooldown must be identical for every poller sharing the runtime database');
    }
    return row.last_started_ms == null ? null : Number(row.last_started_ms);
  }

  /**
   * Atomically claim the start of one automated ticket turn. The cooldown is
   * start-to-start and shared by every poller using this database: two pollers
   * racing after the same window opening cannot both start a turn.
   *
   * A successful claim is consumed immediately. If the dispatch then throws,
   * the anchor is deliberately retained: the agent may already have started and
   * an ambiguous failure must never refund time on the global schedule.
   */
  claimTicketDispatchStart(options: { cooldownMs: number; now?: number }): {
    acquired: boolean;
    lastStartedAt: number | null;
    nextAllowedAt: number | null;
  } {
    const cooldownMs = options.cooldownMs;
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) {
      throw new Error('ticket delivery cooldown must be a non-negative integer');
    }
    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('ticket dispatch timestamp must be a non-negative integer');
    return this.transaction(() => {
      const row = asSqlRow<SqlRow>(this.db.prepare(
        'SELECT cooldown_ms,last_started_ms FROM ticket_delivery_state WHERE singleton=1').get());
      if (row && Number(row.cooldown_ms) !== cooldownMs) {
        throw new Error('ticket delivery cooldown must be identical for every poller sharing the runtime database');
      }
      const lastStartedAt = row?.last_started_ms == null ? null : Number(row.last_started_ms);
      if (lastStartedAt !== null && now < lastStartedAt + cooldownMs) {
        return { acquired: false, lastStartedAt, nextAllowedAt: lastStartedAt + cooldownMs };
      }
      if (!row) {
        this.db.prepare('INSERT INTO ticket_delivery_state(singleton,cooldown_ms,last_started_ms) VALUES (1,?,?)')
          .run(cooldownMs, now);
      } else {
        this.db.prepare('UPDATE ticket_delivery_state SET last_started_ms=? WHERE singleton=1').run(now);
      }
      return { acquired: true, lastStartedAt: now, nextAllowedAt: null };
    });
  }

  /**
   * Explicit operator transition to a new global cooldown. The durable
   * last-start anchor is preserved and the new cooldown applies to it
   * immediately: lowering the cooldown can make the next dispatch eligible at
   * `last_started_ms + new_cooldown`, which may already be in the past. The
   * result reports that boundary so the operator sees the effect. Refusing
   * while a live ticket lease exists makes the transition deliberate; a poller
   * still running with the old value fails closed on its next read or claim.
   */
  reconfigureTicketDelivery(options: { cooldownMs: number }): {
    changed: boolean;
    previousCooldownMs: number | null;
    cooldownMs: number;
    lastStartedAt: number | null;
    nextAllowedAt: number | null;
  } {
    const cooldownMs = options.cooldownMs;
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) {
      throw new Error('ticket delivery cooldown must be a non-negative integer');
    }
    return this.transaction(() => {
      const active = this.db.prepare(`SELECT id,state_json,active_pid,active_start_ticks,
        active_namespace,active_lease_until,active_kind FROM ticket_handoffs WHERE active_owner IS NOT NULL`)
        .all() as unknown as TicketOwnerRow[];
      if (active.some((row) => ticketOwnerAlive(row))) {
        throw new Error('ticket delivery reconfiguration requires every active ticket session and intake claim to stop first');
      }
      const row = asSqlRow<SqlRow>(this.db.prepare(
        'SELECT cooldown_ms,last_started_ms FROM ticket_delivery_state WHERE singleton=1').get());
      const previousCooldownMs = row ? Number(row.cooldown_ms) : null;
      const lastStartedAt = row?.last_started_ms == null ? null : Number(row.last_started_ms);
      if (!row) {
        this.db.prepare('INSERT INTO ticket_delivery_state(singleton,cooldown_ms,last_started_ms) VALUES (1,?,NULL)')
          .run(cooldownMs);
      } else {
        this.db.prepare('UPDATE ticket_delivery_state SET cooldown_ms=? WHERE singleton=1').run(cooldownMs);
      }
      return {
        changed: previousCooldownMs !== cooldownMs,
        previousCooldownMs,
        cooldownMs,
        lastStartedAt,
        nextAllowedAt: lastStartedAt === null ? null : lastStartedAt + cooldownMs,
      };
    });
  }


  releaseTicketHandoff(id: string, owner: string): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE ticket_handoffs SET active_owner=NULL,active_pid=NULL,active_start_ticks=NULL,
        active_namespace=NULL,active_heartbeat_at=NULL,active_lease_until=NULL,active_kind=NULL,updated_at=?
        WHERE id=? AND active_owner=?`).run(nowIso(), id, owner);
    });
  }

  /** Serialize a CLI mutation without filesystem locks; dead owners are reclaimed. */
  withMutationGuard<T>(fn: () => T): T {
    const ownerToken = randomUUID();
    this.transaction(() => {
      const current = asSqlRow<MutationGuardRow>(this.db.prepare('SELECT owner_token, pid FROM mutation_guards WHERE id=1').get());
      if (current) {
        let alive = true;
        try {
          process.kill(Number(current.pid), 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code === 'EPERM';
        }
        if (alive) throw new Error('another queue mutation is in progress; retry when it finishes');
        this.db.prepare('DELETE FROM mutation_guards WHERE id=1 AND owner_token=?').run(current.owner_token);
      }
      this.db.prepare('INSERT INTO mutation_guards(id, owner_token, pid, acquired_at) VALUES (1, ?, ?, ?)')
        .run(ownerToken, process.pid, nowIso());
    });
    const release = () => this.transaction(() =>
      this.db.prepare('DELETE FROM mutation_guards WHERE id=1 AND owner_token=?').run(ownerToken));
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        return (result as Promise<unknown>).finally(release) as T;
      }
      release();
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    for (;;) {
      const applied = this.transaction(() => {
        // Read the current version after taking the write lock. Two processes
        // starting against an empty DB must not both apply the same migration.
        const versionRow = asSqlRow<SchemaVersionRow>(
          this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get(),
        );
        const current = Number(versionRow?.version ?? 0);
        if (current > MIGRATIONS.length) {
          throw new Error(
            `Database schema version ${current} is newer than supported version ${MIGRATIONS.length}; ` +
            'upgrade issue-orchestrator before opening this database',
          );
        }
        if (current >= MIGRATIONS.length) return false;
        this.db.exec(MIGRATIONS[current]);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(current + 1, nowIso());
        return true;
      });
      if (!applied) break;
    }
  }

  private transaction<T>(fn: () => T): T {
    const outer = this.db.isTransaction;
    if (!outer) this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (!outer) this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (!outer) {
        try { this.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      }
      throw error;
    }
  }

  /** Import the old JSON files once; SQLite is authoritative after the import. */
  importLegacy(lockFile: string, stateFile?: string, configFile?: string) {
    const sources = [lockFile, stateFile].filter((file): file is string => !!file);
    for (const source of sources) {
      const absolute = path.resolve(source);
      const done = this.db.prepare('SELECT 1 FROM legacy_imports WHERE source_path = ?').get(absolute);
      if (done) continue;
      let value: unknown = null;
      const sourceExists = fs.existsSync(absolute);
      const isLockFile = path.basename(absolute) === 'lock.json';
      try {
        if (sourceExists) value = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      } catch (error) {
        throw new Error(`Legacy ${isLockFile ? 'lock' : 'state'} is corrupt: ${absolute} (${(error as Error).message})`, { cause: error });
      }
      const legacyLock = isValidLegacyLock(value) ? value : null;
      if (sourceExists && isLockFile && !legacyLock) {
        throw new Error(`Legacy lock is corrupt: ${absolute} (missing valid repo, issue, or owner_token)`);
      }
      const legacyState = isRecord(value) && !isLockFile ? value : null;
      const legacyActive = legacyState && isValidLegacyLock(legacyState.active) ? legacyState.active : null;
      this.transaction(() => {
        if (legacyLock && isLockFile) {
          this.importLegacyLock(legacyLock);
        } else if (legacyState && path.basename(absolute) === 'state.json') {
          const stateConfig = path.resolve(configFile ?? path.join(path.dirname(absolute), 'config.jsonc'));
          let job = legacyActive
            ? asSqlRow<IdRow>(this.db.prepare("SELECT id FROM jobs WHERE owner_token = ? AND state IN ('CLAIMED', 'RUNNING')")
              .get(legacyActive.owner_token)) ?? null
            : null;
          if (!job && legacyActive) {
            const jobId = this.importLegacyLock(legacyActive);
            if (jobId !== null) job = { id: jobId };
          }
          this.db.prepare(`
            INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)
            ON CONFLICT(config_file) DO UPDATE SET
              active_job_id = COALESCE(excluded.active_job_id, runtime_state.active_job_id),
              last_run = COALESCE(excluded.last_run, runtime_state.last_run)
          `).run(stateConfig, job?.id ?? null,
            typeof legacyState.last_run === 'string' ? legacyState.last_run : null);
        }
        this.db.prepare('INSERT OR IGNORE INTO legacy_imports VALUES (?, ?)').run(absolute, nowIso());
      });
    }
  }

  /** Archive malformed legacy ownership only after explicit stale confirmation. */
  quarantineCorruptLegacyLock(lockFile: string, stateFile: string, configFile: string) {
    const absoluteLock = path.resolve(lockFile);
    let lock: unknown;
    try {
      lock = JSON.parse(fs.readFileSync(absoluteLock, 'utf8'));
    } catch {
      lock = null;
    }
    if (isValidLegacyLock(lock)) throw new Error(`Legacy lock is valid and was not quarantined: ${absoluteLock}`);

    const absoluteState = path.resolve(stateFile);
    const suffix = `${Date.now()}.${randomUUID()}`;
    const archive = `${absoluteLock}.corrupt.${suffix}`;
    const stateArchive = `${absoluteState}.corrupt.${suffix}`;
    let lastRun: string | null = null;
    let legacyActive: LegacyLock | null = null;
    try {
      const state: unknown = JSON.parse(fs.readFileSync(absoluteState, 'utf8'));
      if (isRecord(state)) {
        lastRun = typeof state.last_run === 'string' ? state.last_run : null;
        legacyActive = isValidLegacyLock(state.active) ? state.active : null;
      }
    } catch {
      // The original state file will be kept in the quarantine archive.
    }
    // Move state first so a crash between renames cannot import stale active
    // ownership from state.json after the malformed lock disappears.
    const archivedState = fs.existsSync(absoluteState);
    if (archivedState) fs.renameSync(absoluteState, stateArchive);
    fs.renameSync(absoluteLock, archive);

    let activeJobReleased = false;
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO legacy_imports VALUES (?, ?)').run(absoluteLock, nowIso());
      this.db.prepare('INSERT OR IGNORE INTO legacy_imports VALUES (?, ?)').run(absoluteState, nowIso());
      const current = this.readLock();
      const configPath = path.resolve(configFile);
      const identityMatches = current && legacyActive &&
        current.owner_token === legacyActive.owner_token &&
        current.repo === legacyActive.repo && current.issue === Number(legacyActive.issue) &&
        (!legacyActive.config_file || path.resolve(legacyActive.config_file) === configPath);
      if (identityMatches) {
        activeJobReleased = this.finishActiveJob(
          current.owner_token,
          'RELEASED',
          'forced recovery after corrupt legacy lock quarantine',
        );
      }
      if (!current || identityMatches) {
        this.db.prepare(`
          INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, NULL, ?)
          ON CONFLICT(config_file) DO UPDATE SET active_job_id=NULL, last_run=excluded.last_run
        `).run(configPath, lastRun ?? nowIso());
      }
    });
    return { lock: archive, state: archivedState ? stateArchive : null, activeJobReleased };
  }

  private importLegacyLock(lock: LegacyLock): number | null {
    if (!lock?.repo || !lock?.issue || !lock?.owner_token) return null;
    const active = asSqlRow<IdRow>(this.db.prepare("SELECT id FROM jobs WHERE state IN ('CLAIMED', 'RUNNING') LIMIT 1").get());
    if (active) {
      const same = asSqlRow<IdRow>(this.db.prepare('SELECT id FROM jobs WHERE id=? AND owner_token=?')
        .get(active.id, lock.owner_token));
      return same ? Number(same.id) : null;
    }
    const stamp = lock.claimed_at ?? nowIso();
    this.upsertProject(lock.repo, lock.provider ?? 'github', lock.config_file, !!lock.local_only);
    const item = asSqlRow<IdRow>(this.db.prepare(`
      INSERT INTO work_items(project_id, external_id, state, attempts, created_at, updated_at)
      VALUES (?, ?, 'READY', 0, ?, ?)
      ON CONFLICT(project_id, external_id) DO UPDATE SET state = 'READY', updated_at = excluded.updated_at
      RETURNING id
    `).get(lock.repo, String(lock.issue), stamp, stamp));
    if (!item) throw new Error(`Could not migrate legacy work item ${lock.repo}#${lock.issue}`);
    this.db.prepare("UPDATE work_items SET state='CLAIMED' WHERE id=? AND state='READY' RETURNING id").get(item.id);
    const job = asSqlRow<IdRow>(this.db.prepare(`
      INSERT INTO jobs(project_id, work_item_id, owner_token, config_file, provider, state, workflow_state, stage, branch,
        account, local_only, claimed_by, claimed_at, heartbeat_at, lease_expires_at, attempts,
        change_number, head_sha, evidence_commit, release_result, resumed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'CLAIMED', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      lock.repo, item.id, lock.owner_token, lock.config_file ?? null, lock.provider ?? 'github',
      legacyWorkflowState(lock.stage, lock.release_result), lock.stage ?? 'claimed', lock.branch ?? null, lock.account ?? null, lock.local_only ? 1 : 0,
      String(process.pid), stamp, lock.updated_at ?? stamp,
      new Date(Date.parse(lock.updated_at ?? stamp) + DEFAULT_LEASE_MS).toISOString(),
      lock.change_number ?? null, lock.head_sha ?? null, lock.evidence_commit ?? null,
      lock.release_result ?? null, lock.resumed_at ?? null, stamp, lock.updated_at ?? stamp,
    ));
    if (!job) throw new Error(`Could not migrate legacy job ${lock.repo}#${lock.issue}`);
    this.recordTransition(Number(job.id), null, 'CLAIMED', 'legacy import', 'migration', stamp);
    if (lock.config_file) {
      this.db.prepare('INSERT OR REPLACE INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)')
        .run(path.resolve(lock.config_file), job.id, lock.updated_at ?? stamp);
    }
    return Number(job.id);
  }

  private upsertProject(project: string, provider: string, configFile?: string, localOnly = false) {
    const stamp = nowIso();
    this.db.prepare(`
      INSERT INTO projects(id, provider, config_file, enabled, local_only, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,
        config_file=COALESCE(excluded.config_file, projects.config_file),
        local_only=excluded.local_only, updated_at=excluded.updated_at
    `).run(project, provider, configFile ?? null, localOnly ? 1 : 0, stamp, stamp);
  }

  private clearProjectCapacityIfIdle(project: string, provider: string) {
    const jobPredicate = githubProjectPredicate('j.project_id', provider);
    const trackerPredicate = trackerProviderPredicate('j', provider);
    const active = this.db.prepare(`SELECT 1 FROM jobs j WHERE ${jobPredicate} AND ${trackerPredicate} AND j.state IN ('CLAIMED','RUNNING') LIMIT 1`).get(project);
    if (!active) {
      // These summary rows have no tracker identity and are never authoritative.
      // Do not delete another tracker/config's persisted cap data here.
    }
  }

  private clearInactiveProjectConfigCap(configFile: string, project: string, provider: string) {
    // Do not delete case aliases: the legacy cap table has no tracker key, so
    // a row may represent an active project on a different tracker. Enforcement
    // uses exact persisted project spelling and ignores these stale aliases.
    void configFile;
    void project;
    void provider;
  }

  readLock(): Lock | null {
    const rows = asSqlRows<LockRow>(this.db.prepare(`
      SELECT j.*, w.external_id, j.project_id
      FROM jobs j JOIN work_items w ON w.id=j.work_item_id
      WHERE j.state IN ('CLAIMED', 'RUNNING') ORDER BY j.claimed_at, j.id LIMIT 2
    `).all());
    // The legacy diagnostic API has a singular result. Never misattribute an
    // arbitrary job once concurrent claims are enabled.
    return rows.length === 1 ? fromRow(rows[0]) : null;
  }

  activeJobCount(): number {
    return Number(asSqlRow<CountRow>(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('CLAIMED','RUNNING')").get())?.count ?? 0);
  }

  readLockByOwner(ownerToken: string): Lock | null {
    return fromRow(asSqlRow<LockRow>(this.db.prepare(`SELECT j.*, w.external_id FROM jobs j
      JOIN work_items w ON w.id=j.work_item_id WHERE j.owner_token=? AND j.state IN ('CLAIMED','RUNNING')`).get(ownerToken)));
  }

  readLockForWorkItem(project: string, issue: string | number): Lock | null {
    const rows = asSqlRows<LockRow>(this.db.prepare(`SELECT j.*, w.external_id FROM jobs j
      JOIN work_items w ON w.id=j.work_item_id WHERE (j.project_id=? OR
        (lower(j.project_id)=lower(?) AND ${trackerProviderPredicate('j', 'github')}))
        AND w.external_id=? AND j.state IN ('CLAIMED','RUNNING') LIMIT 2`).all(project, project, String(issue)));
    return rows.length === 1 ? fromRow(rows[0]) : null;
  }

  hasReadyJob(project: string, issue: string | number, configFile: string): string | null {
    const row = asSqlRow<SqlRow>(this.db.prepare(`SELECT j.workflow_state FROM jobs j JOIN work_items w ON w.id=j.work_item_id
      WHERE (j.project_id=? OR (lower(j.project_id)=lower(?) AND ${trackerProviderPredicate('j', 'github')}))
        AND w.external_id=? AND j.config_file=? AND j.state='READY' LIMIT 1`)
      .get(project, project, String(issue), path.resolve(configFile)));
    return typeof row?.workflow_state === 'string' ? row.workflow_state : null;
  }

  readState(configFile: string) {
    const absolute = path.resolve(configFile);
    const state = asSqlRow<RuntimeStateRow>(
      this.db.prepare('SELECT active_job_id, last_run FROM runtime_state WHERE config_file=?').get(absolute),
    );
    if (!state) return { active: null, last_run: null };
    const row = state.active_job_id == null ? undefined : asSqlRow<LockRow>(this.db.prepare(`
      SELECT j.*, w.external_id FROM jobs j JOIN work_items w ON w.id=j.work_item_id
      WHERE j.id=? AND j.state IN ('CLAIMED', 'RUNNING')
    `).get(state.active_job_id));
    return { active: fromRow(row), last_run: state.last_run ?? null };
  }

  readResumableLock(configFile: string, projectLimits: Record<string, { maxConcurrency?: number; projectConcurrency?: number; resourceLocks?: string[] }> = {}, requestedProject?: string): Lock | null {
    return this.transaction(() => {
      const rows = asSqlRows<LockRow & { lease_pid?: number | bigint | null; lease_start_ticks?: string | null }>(this.db.prepare(`
        SELECT j.*, w.external_id FROM jobs j JOIN work_items w ON w.id=j.work_item_id
        WHERE j.config_file=? AND j.state IN ('CLAIMED','RUNNING') ORDER BY j.claimed_at, j.id
      `).all(path.resolve(configFile)));
      for (const row of rows) {
        if (requestedProject !== undefined && String(row.project_id) !== requestedProject &&
            !(isGitHubTracker(String(row.provider)) && String(row.project_id).toLowerCase() === requestedProject.toLowerCase())) continue;
         let limits = projectLimits[String(row.project_id)] ?? (isGitHubTracker(String(row.provider))
           ? Object.entries(projectLimits).find(([project]) => project.toLowerCase() === String(row.project_id).toLowerCase())?.[1]
           : undefined);
         if (Object.keys(projectLimits).length === 0) limits = {};
         else if (!limits) continue;
        const pid = Number(row.lease_pid);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        if (processOwnerAlive(pid, row.lease_start_ticks) !== false) continue;
        const globalCap = limits.maxConcurrency ?? 1;
        const projectCap = limits.projectConcurrency ?? globalCap;
        if (!Number.isSafeInteger(globalCap) || globalCap < 1 || !Number.isSafeInteger(projectCap) || projectCap < 1 || projectCap > globalCap) continue;
        const active = this.activeJobCount();
        if (active > globalCap) continue;
        const provider = String(row.provider);
        const projectPredicate = githubProjectPredicate('j.project_id', provider);
        const projectActive = Number(asSqlRow<CountRow>(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs j WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', provider)} AND j.state IN ('CLAIMED','RUNNING')`).get(row.project_id))?.count ?? 0);
        if (projectActive > projectCap) continue;
        const storedGlobal = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_global_limit WHERE singleton=1').get());
        if (storedGlobal && Number(storedGlobal.max_concurrency) !== globalCap) continue;
         const storedProject = asSqlRow<SqlRow>(this.db.prepare(`SELECT max_concurrency FROM scheduler_project_caps WHERE config_file=? AND project_id=?`).get(String(row.config_file), String(row.project_id)));
         if ((storedProject ? Number(storedProject.max_concurrency) : 1) !== projectCap) continue;
        const held = new Set(this.db.prepare('SELECT resource FROM job_resource_locks WHERE job_id=? AND owner_token=?').all(row.id, row.owner_token).map((lock) => String((lock as SqlRow).resource)));
        const missing = [...new Set(limits.resourceLocks ?? [])].filter((resource) => !held.has(resource));
        if (missing.some((resource) => this.db.prepare('SELECT 1 FROM job_resource_locks WHERE resource=?').get(resource))) continue;
        const stamp = nowIso();
        const leaseUntil = new Date(Date.now() + DEFAULT_LEASE_MS).toISOString();
        // Reserve newly required resources before renewing ownership; all writes
        // are within this transaction, so a failed reservation leaves the job untouched.
        for (const resource of missing) this.db.prepare('INSERT INTO job_resource_locks(resource,job_id,owner_token,lease_expires_at) VALUES (?,?,?,?)')
          .run(resource, row.id, row.owner_token, leaseUntil);
        const updated = this.db.prepare(`UPDATE jobs SET claimed_by=?, lease_pid=?, lease_start_ticks=?, heartbeat_at=?, lease_expires_at=?, updated_at=?
          WHERE id=? AND lease_pid IS ? AND lease_start_ticks IS ? AND state IN ('CLAIMED','RUNNING')`)
          .run(String(process.pid), process.pid, processStartTicks(process.pid), stamp, leaseUntil, stamp,
            row.id, row.lease_pid ?? null, row.lease_start_ticks ?? null);
        if (Number(updated.changes) !== 1) continue;
        this.db.prepare('UPDATE job_resource_locks SET lease_expires_at=? WHERE job_id=? AND owner_token=?').run(leaseUntil, row.id, row.owner_token);
        this.db.prepare('INSERT INTO scheduler_global_limit(singleton,max_concurrency) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(globalCap);
        this.db.prepare('INSERT INTO scheduler_config(config_file,max_concurrency) VALUES (?,?) ON CONFLICT(config_file) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(path.resolve(configFile), globalCap);
        this.db.prepare('INSERT INTO scheduler_project_caps(config_file,project_id,max_concurrency) VALUES (?,?,?) ON CONFLICT(config_file,project_id) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(path.resolve(configFile), row.project_id, projectCap);
        return fromRow(asSqlRow<LockRow>(this.db.prepare(`SELECT j.*, w.external_id FROM jobs j
          JOIN work_items w ON w.id=j.work_item_id WHERE j.id=?`).get(row.id)));
      }
      return null;
    });
  }

  isLiveJob(jobId: number): boolean {
    const row = asSqlRow<SqlRow>(this.db.prepare("SELECT lease_pid,lease_start_ticks FROM jobs WHERE id=? AND state IN ('CLAIMED','RUNNING')").get(jobId));
    if (!row) return false;
    const pid = Number(row?.lease_pid);
    return processOwnerAlive(pid, row?.lease_start_ticks) !== false;
  }

  writeState(state: RuntimeStateInput, configFile: string) {
    const absolute = path.resolve(configFile);
    const job = state.active?.owner_token
      ? asSqlRow<IdRow>(this.db.prepare('SELECT id FROM jobs WHERE owner_token=?').get(state.active.owner_token))
      : null;
    this.db.prepare(`
      INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)
      ON CONFLICT(config_file) DO UPDATE SET active_job_id=CASE
        WHEN runtime_state.active_job_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM jobs WHERE id=runtime_state.active_job_id AND state IN ('CLAIMED','RUNNING')
        ) THEN runtime_state.active_job_id ELSE excluded.active_job_id END,
        last_run=excluded.last_run
    `).run(absolute, job?.id ?? null, state.last_run ?? null);
  }

  acquireLock(lock: Lock, force = false, expectedOwnerToken?: string, limits: { maxConcurrency?: number; projectConcurrency?: number; resourceLocks?: string[] } = {}) {
    assertResourceLocks(limits.resourceLocks);
    const projectPredicate = githubProjectPredicate('j.project_id', lock.provider);
    let retryExhausted = false;
    const claimed = this.transaction(() => {
      this.reapExpiredInTransaction(Date.now());
      const current = this.readLock();
      const maxConcurrency = limits.maxConcurrency ?? 1;
      if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('max_concurrency must be a positive integer');
      const requestedProjectCap = limits.projectConcurrency ?? maxConcurrency;
      if (!Number.isSafeInteger(requestedProjectCap) || requestedProjectCap < 1 || requestedProjectCap > maxConcurrency) {
        throw new Error('project max_concurrency must be a positive integer not exceeding global max_concurrency');
      }
      const activeCount = Number(asSqlRow<CountRow>(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('CLAIMED','RUNNING')").get())?.count ?? 0);
      const dbGlobalLimit = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_global_limit WHERE singleton=1').get());
      if (activeCount > 0 && !dbGlobalLimit && maxConcurrency !== 1) throw new Error('Legacy active jobs use the default max_concurrency=1 until released');
      if (activeCount > 0 && dbGlobalLimit && Number(dbGlobalLimit.max_concurrency) !== maxConcurrency) throw new Error('Active configurations sharing ISSUE_ORCHESTRATOR_HOME must use the same max_concurrency');
      const activeConfigs = asSqlRows<SqlRow>(this.db.prepare("SELECT DISTINCT config_file FROM jobs WHERE state IN ('CLAIMED','RUNNING') AND config_file IS NOT NULL").all());
      for (const activeConfig of activeConfigs) {
        const configured = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_config WHERE config_file=?').get(activeConfig.config_file));
        if (configured && Number(configured.max_concurrency) !== maxConcurrency) throw new Error('Active configurations sharing ISSUE_ORCHESTRATOR_HOME must use the same max_concurrency');
      }
      if (activeCount - (force && current ? 1 : 0) >= maxConcurrency) throw new Error(`Global run capacity is full (${activeCount}/${maxConcurrency})`);
      const duplicateOwner = this.db.prepare(`SELECT 1 FROM jobs j JOIN work_items w ON w.id=j.work_item_id
        WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', lock.provider)} AND w.external_id=? AND j.state IN ('CLAIMED','RUNNING') LIMIT 1`).get(lock.repo, String(lock.issue));
      if (duplicateOwner && !(force && current && sameTrackerProject(current.repo, current.provider, lock.repo, lock.provider) && Number(current.issue) === Number(lock.issue))) throw new Error(`Work item ${lock.repo}#${lock.issue} already has an active owner`);
      const projectActive = Number(asSqlRow<CountRow>(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs j WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', lock.provider)} AND state IN ('CLAIMED','RUNNING')`).get(lock.repo))?.count ?? 0);
      const projectCap = requestedProjectCap;
      this.clearInactiveProjectConfigCap(path.resolve(lock.config_file), lock.repo, lock.provider);
       const activeProjectRows = asSqlRows<SqlRow>(this.db.prepare(`SELECT j.config_file,j.project_id FROM jobs j
         WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', lock.provider)} AND j.state IN ('CLAIMED','RUNNING')`).all(lock.repo));
       for (const active of activeProjectRows) {
         const configured = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_project_caps WHERE config_file=? AND project_id=?').get(active.config_file, active.project_id));
         if ((configured ? Number(configured.max_concurrency) : 1) !== projectCap) throw new Error(`Active configurations sharing project ${lock.repo} must use the same project concurrency cap`);
       }
      if (projectActive - (force && current && sameTrackerProject(current.repo, current.provider, lock.repo, lock.provider) ? 1 : 0) >= projectCap) throw new Error(`Project run capacity is full for ${lock.repo}`);
      const exhausted = this.db.prepare(`
        SELECT j.id FROM jobs j JOIN work_items w ON w.id=j.work_item_id
        WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', lock.provider)} AND w.external_id=? AND j.state='FAILED' AND j.attempts >= j.max_attempts
        LIMIT 1
      `).get(lock.repo, String(lock.issue));
      if (exhausted) {
        retryExhausted = true;
        return null;
      }
      if (isGitHubTracker(lock.provider)) {
        const legacyIdentity = this.db.prepare(`SELECT 1 FROM work_items w JOIN jobs j ON j.work_item_id=w.id
          WHERE lower(w.project_id)=lower(?) AND w.external_id=? AND w.project_id<>?
            AND ${trackerProviderPredicate('j', lock.provider)} LIMIT 1`)
          .get(lock.repo, String(lock.issue), lock.repo);
        // Preserve retry/workflow history rather than creating a second row under new casing.
        if (legacyIdentity) throw new Error(`Work item ${lock.repo}#${lock.issue} has existing history under a different project spelling; refusing a new CLI claim`);
      }

      if (current && !force && sameTrackerProject(current.repo, current.provider, lock.repo, lock.provider) && Number(current.issue) === Number(lock.issue)) {
        throw new Error(`Work item ${lock.repo}#${lock.issue} already has an active owner`);
      }
      if (current && force) {
        if (!expectedOwnerToken || current.owner_token !== expectedOwnerToken) {
          throw new Error('Queue ownership changed after stale confirmation; refusing to replace the active run');
        }
        this.finishActiveJob(current.owner_token, 'ABANDONED', 'forced claim after stale confirmation');
      }

      this.upsertProject(lock.repo, lock.provider, lock.config_file, !!lock.local_only);
      const item = asSqlRow<IdRow>(this.db.prepare(`
        INSERT INTO work_items(project_id, external_id, state, attempts, created_at, updated_at)
        VALUES (?, ?, 'READY', 0, ?, ?)
        ON CONFLICT(project_id, external_id) DO UPDATE SET state='READY', updated_at=excluded.updated_at
        RETURNING id
      `).get(lock.repo, String(lock.issue), lock.claimed_at, lock.updated_at));
      if (!item) throw new Error(`Could not create work item ${lock.repo}#${lock.issue}`);
      const itemClaim = this.db.prepare("UPDATE work_items SET state='CLAIMED', attempts=attempts+1, updated_at=? WHERE id=? AND state='READY' RETURNING id")
        .get(lock.updated_at, item.id);
      if (!itemClaim) throw new Error(`Work item ${lock.repo}#${lock.issue} is not ready to claim`);

      let queued = asSqlRow<IdRow>(
        this.db.prepare("SELECT id FROM jobs WHERE work_item_id=? AND state='READY' ORDER BY id LIMIT 1").get(item.id),
      );
      if (!queued) {
        queued = asSqlRow<IdRow>(this.db.prepare(`
          INSERT INTO jobs(project_id, work_item_id, provider, state, workflow_state, attempts, created_at, updated_at)
          VALUES (?, ?, ?, 'READY', 'READY', 0, ?, ?) RETURNING id
        `).get(lock.repo, item.id, lock.provider, lock.claimed_at, lock.updated_at));
        if (!queued) throw new Error(`Could not queue work item ${lock.repo}#${lock.issue}`);
        this.recordTransition(Number(queued.id), null, 'READY', 'work item queued for CLI claim', lock.owner_token, lock.claimed_at);
      }
      const leaseMs = Number(lock.lease_ms ?? DEFAULT_LEASE_MS);
      const updated = asSqlRow<IdRow>(this.db.prepare(`
        UPDATE jobs SET owner_token=?, config_file=?, provider=?, state='CLAIMED', stage=COALESCE(stage,?), branch=COALESCE(?,branch), account=?,
          local_only=?, claimed_by=?, lease_pid=?, lease_start_ticks=?, claimed_at=?, heartbeat_at=?, lease_expires_at=?, attempts=attempts+1,
          change_number=COALESCE(?,change_number), head_sha=COALESCE(?,head_sha),
          evidence_commit=COALESCE(?,evidence_commit), updated_at=?
        WHERE id=? AND state='READY' RETURNING id
      `).get(
        lock.owner_token, path.resolve(lock.config_file), lock.provider, lock.stage ?? 'claimed', lock.branch ?? null,
        lock.account ?? null, lock.local_only ? 1 : 0, String(process.pid), process.pid, processStartTicks(process.pid), lock.claimed_at, lock.updated_at,
        new Date(Date.parse(lock.updated_at) + leaseMs).toISOString(), lock.change_number ?? null,
        lock.head_sha ?? null, lock.evidence_commit ?? null, lock.updated_at, queued.id,
      ));
      if (!updated) throw new Error(`Job for ${lock.repo}#${lock.issue} is not ready to claim`);
      for (const resource of [...new Set(limits.resourceLocks ?? [])]) {
        const reserved = this.db.prepare('INSERT OR IGNORE INTO job_resource_locks(resource, job_id, owner_token, lease_expires_at) VALUES (?, ?, ?, ?)')
          .run(resource, updated.id, lock.owner_token, new Date(Date.parse(lock.updated_at) + leaseMs).toISOString());
        if (Number(reserved.changes) !== 1) throw new Error(`Resource lock is busy: ${resource}`);
      }
      this.db.prepare('INSERT INTO scheduler_config(config_file,max_concurrency) VALUES (?,?) ON CONFLICT(config_file) DO UPDATE SET max_concurrency=excluded.max_concurrency')
        .run(path.resolve(lock.config_file), maxConcurrency);
      this.db.prepare('INSERT INTO scheduler_project_caps(config_file,project_id,max_concurrency) VALUES (?,?,?) ON CONFLICT(config_file,project_id) DO UPDATE SET max_concurrency=excluded.max_concurrency')
        .run(path.resolve(lock.config_file), lock.repo, projectCap);
      this.db.prepare('INSERT INTO scheduler_global_limit(singleton,max_concurrency) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(maxConcurrency);
      this.recordTransition(Number(updated.id), 'READY', 'CLAIMED', 'claimed from CLI', lock.owner_token, lock.claimed_at);
      const workflow = asSqlRow<SqlRow>(this.db.prepare('SELECT workflow_state FROM jobs WHERE id=?').get(updated.id));
      if (workflow?.workflow_state === 'READY') {
        this.transitionWorkflowInTransaction(Number(updated.id), 'CLAIMED', 'cli', 'trusted issue claimed');
      }
      this.db.prepare(`
        INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)
        ON CONFLICT(config_file) DO UPDATE SET active_job_id=CASE
          WHEN runtime_state.active_job_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM jobs WHERE id=runtime_state.active_job_id AND state IN ('CLAIMED','RUNNING')
          ) THEN runtime_state.active_job_id ELSE excluded.active_job_id END,
          last_run=excluded.last_run
      `).run(path.resolve(lock.config_file), updated.id, lock.updated_at);
      return fromRow(asSqlRow<LockRow>(
        this.db.prepare('SELECT j.*, w.external_id FROM jobs j JOIN work_items w ON w.id=j.work_item_id WHERE j.id=?').get(updated.id),
      ));
    });
    if (retryExhausted) {
      throw new Error(`Work item ${lock.repo}#${lock.issue} exhausted max_attempts; refusing a new CLI claim`);
    }
    return claimed;
  }

  updateLock(lock: Lock) {
    return this.transaction(() => {
      const before = asSqlRow<JobTransitionRow>(
        this.db.prepare("SELECT id, stage, state FROM jobs WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')")
          .get(lock.owner_token),
      );
      if (!before) throw new Error('Queue lock ownership changed; refusing to update another run\'s lock');
      const heartbeatAt = nowIso();
      const leaseUntil = new Date(Date.now() + DEFAULT_LEASE_MS).toISOString();
      this.db.prepare(`
        UPDATE jobs SET config_file=?, stage=?, branch=?, account=?, local_only=?, change_number=?, head_sha=?,
          evidence_commit=?, release_result=?, resumed_at=?, heartbeat_at=?,
          lease_expires_at=?, lease_pid=?, lease_start_ticks=?, updated_at=? WHERE id=?
      `).run(
        path.resolve(lock.config_file), lock.stage ?? null, lock.branch ?? null, lock.account ?? null,
        lock.local_only ? 1 : 0, lock.change_number ?? null, lock.head_sha ?? null, lock.evidence_commit ?? null,
        lock.release_result ?? null, lock.resumed_at ?? null, heartbeatAt,
        leaseUntil, process.pid, processStartTicks(process.pid), lock.updated_at ?? heartbeatAt, before.id,
      );
      this.db.prepare('UPDATE job_resource_locks SET lease_expires_at=? WHERE job_id=? AND owner_token=?')
        .run(leaseUntil, before.id, lock.owner_token);
      if (before.stage !== lock.stage) {
        this.recordTransition(Number(before.id), before.state, before.state,
          `workflow checkpoint: ${before.stage ?? '(unset)'} -> ${lock.stage ?? '(unset)'}`,
          lock.owner_token, lock.updated_at ?? nowIso());
      }
      this.db.prepare(`
        INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)
        ON CONFLICT(config_file) DO UPDATE SET active_job_id=CASE
          WHEN runtime_state.active_job_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM jobs WHERE id=runtime_state.active_job_id AND state IN ('CLAIMED','RUNNING')
          ) THEN runtime_state.active_job_id ELSE excluded.active_job_id END,
          last_run=excluded.last_run
      `).run(path.resolve(lock.config_file), before.id, lock.updated_at ?? nowIso());
      return lock;
    });
  }

  checkpointImplementation(lock: Lock) {
    if (!/^[a-f0-9]{40}$/i.test(lock.head_sha ?? '') || !lock.branch) {
      throw new Error('implementation checkpoint requires a branch and full head SHA');
    }
    return this.transaction(() => {
      const job = asSqlRow<SqlRow>(this.db.prepare(`
        SELECT id, workflow_state, head_sha, branch FROM jobs
        WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')
      `).get(lock.owner_token));
      if (!job) throw new Error('Queue lock ownership changed; refusing implementation checkpoint');
      const jobId = Number(job.id);
      if (job.workflow_state === 'IMPLEMENTED') {
        if (String(job.head_sha ?? '').toLowerCase() !== lock.head_sha.toLowerCase() || job.branch !== lock.branch) {
          throw new Error('Existing implementation checkpoint differs from the committed head');
        }
        return lock;
      }
      if (job.workflow_state !== 'IMPLEMENTING') {
        throw new Error(`Cannot checkpoint implementation from workflow state ${String(job.workflow_state)}`);
      }
      const stamp = lock.updated_at ?? nowIso();
      const leaseUntil = new Date(Date.now() + DEFAULT_LEASE_MS).toISOString();
      this.db.prepare(`
        UPDATE jobs SET stage=?, branch=?, head_sha=?, updated_at=?, heartbeat_at=?, lease_expires_at=?,
          lease_pid=?, lease_start_ticks=?
        WHERE id=? AND owner_token=?
      `).run(
        lock.stage ?? 'implemented', lock.branch, lock.head_sha.toLowerCase(), stamp, nowIso(),
        leaseUntil, process.pid, processStartTicks(process.pid), jobId, lock.owner_token,
      );
      this.db.prepare('UPDATE job_resource_locks SET lease_expires_at=? WHERE job_id=? AND owner_token=?')
        .run(leaseUntil, jobId, lock.owner_token);
      this.db.prepare('UPDATE runtime_state SET last_run=? WHERE active_job_id=?').run(stamp, jobId);
      this.transitionWorkflowInTransaction(jobId, 'IMPLEMENTED', 'agent', 'builder committed a clean issue-branch change');
      return lock;
    });
  }

  transitionWorkflow(ownerToken: string, to: WorkflowState, actor: WorkflowActor, reason: string) {
    return this.transaction(() => {
      const active = asSqlRow<IdRow>(this.db.prepare(
        "SELECT id FROM jobs WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')",
      ).get(ownerToken));
      if (!active) throw new Error('Queue lock ownership changed; refusing workflow transition');
      return this.transitionWorkflowInTransaction(Number(active.id), to, actor, reason);
    });
  }

  workflowStateForOwner(ownerToken: string) {
    const row = asSqlRow<SqlRow>(this.db.prepare(
      'SELECT workflow_state FROM jobs WHERE owner_token=?',
    ).get(ownerToken));
    if (!row || typeof row.workflow_state !== 'string' || !isWorkflowState(row.workflow_state)) {
      throw new Error('Queue lock ownership changed; no valid workflow state for this owner');
    }
    return row.workflow_state;
  }

  private transitionWorkflowInTransaction(jobId: number, to: WorkflowState, actor: WorkflowActor, reason: string) {
    const job = asSqlRow<SqlRow>(this.db.prepare(`
      SELECT workflow_state, change_number, branch, head_sha, evidence_commit
      FROM jobs WHERE id=?
    `).get(jobId));
    if (!job || typeof job.workflow_state !== 'string' || !isWorkflowState(job.workflow_state)) {
      throw new Error(`Job ${jobId} has an invalid workflow state`);
    }
    const from = job.workflow_state;
    assertWorkflowTransition(from, to, actor);

    const fullHead = typeof job.head_sha === 'string' && /^[a-f0-9]{40}$/i.test(job.head_sha);
    if (to === 'CHANGE_OPEN' && (!Number.isSafeInteger(Number(job.change_number)) || Number(job.change_number) <= 0 ||
        typeof job.branch !== 'string' || !job.branch || !fullHead)) {
      throw new Error('CHANGE_OPEN requires a persisted change number, branch, and full head SHA');
    }
    if (to === 'EVIDENCE_PUBLISHED' && (!fullHead || typeof job.evidence_commit !== 'string' ||
        !/^[a-f0-9]{40}$/i.test(job.evidence_commit))) {
      throw new Error('EVIDENCE_PUBLISHED requires a persisted evidence commit and full head SHA');
    }
    if (to === 'REVIEW_APPROVED' && !this.hasWorkflowCheck(jobId, 'review-approval', 'approved', String(job.head_sha ?? ''))) {
      throw new Error('REVIEW_APPROVED requires an observed trusted approval for the current head SHA');
    }
    if (to === 'CHECKS_GREEN' && !this.hasWorkflowCheck(jobId, 'required-checks', 'green', String(job.head_sha ?? ''))) {
      throw new Error('CHECKS_GREEN requires observed green required checks for the current head SHA');
    }
    if (to === 'DONE' && !this.hasWorkflowCheck(jobId, 'merge', 'merged', String(job.head_sha ?? ''))) {
      throw new Error('DONE requires observed external merge state for the current head SHA');
    }

    const stamp = nowIso();
    this.db.prepare('UPDATE jobs SET workflow_state=?, updated_at=? WHERE id=?').run(to, stamp, jobId);
    this.db.prepare(`
      INSERT INTO workflow_transitions(job_id, from_state, to_state, reason, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, from, to, reason, actor, stamp);
    return true;
  }

  recordWorkflowCheck(ownerToken: string, name: string, status: string, headSha: string, details: unknown = {}) {
    if (!/^[a-f0-9]{40}$/i.test(headSha)) throw new Error('workflow check requires a full head SHA');
    const detailsJson = JSON.stringify(details);
    if (detailsJson === undefined) throw new Error('workflow check details must be JSON serializable');
    return this.transaction(() => {
      const job = asSqlRow<SqlRow>(this.db.prepare(
        "SELECT id, head_sha FROM jobs WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')",
      ).get(ownerToken));
      if (!job) throw new Error('Queue lock ownership changed; refusing to record workflow check');
      if (String(job.head_sha ?? '').toLowerCase() !== headSha.toLowerCase()) {
        throw new Error('Workflow check head SHA differs from the persisted job head');
      }
      this.db.prepare(`
        INSERT INTO checks(job_id, name, status, head_sha, details_json, checked_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(job.id, name, status, headSha.toLowerCase(), detailsJson, nowIso());
      return Number(job.id);
    });
  }

  recordMergedOutcome(ownerToken: string, headSha: string, details: unknown = {}, reason = 'external merge verified') {
    if (!/^[a-f0-9]{40}$/i.test(headSha)) throw new Error('merged outcome requires a full head SHA');
    const detailsJson = JSON.stringify(details);
    if (detailsJson === undefined) throw new Error('merged outcome details must be JSON serializable');
    return this.transaction(() => {
      const job = asSqlRow<SqlRow>(this.db.prepare(`
        SELECT id, head_sha, workflow_state, config_file FROM jobs
        WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')
      `).get(ownerToken));
      if (!job) throw new Error('Queue lock ownership changed; refusing to record merged outcome');
      if (String(job.head_sha ?? '').toLowerCase() !== headSha.toLowerCase()) {
        throw new Error('Merged outcome head SHA differs from the persisted job head');
      }
      const jobId = Number(job.id);
      const workflow = String(job.workflow_state);
      if (workflow !== 'MERGING' && workflow !== 'DONE') {
        throw new Error(`Cannot record merged outcome from workflow state ${workflow}`);
      }
      if (!this.hasWorkflowCheck(jobId, 'merge', 'merged', headSha)) {
        this.db.prepare(`
          INSERT INTO checks(job_id, name, status, head_sha, details_json, checked_at)
          VALUES (?, 'merge', 'merged', ?, ?, ?)
        `).run(jobId, headSha.toLowerCase(), detailsJson, nowIso());
      }
      if (workflow === 'MERGING') {
        this.transitionWorkflowInTransaction(jobId, 'DONE', 'cli', reason);
      }
      const stamp = nowIso();
      this.db.prepare("UPDATE jobs SET stage='merged', updated_at=? WHERE id=? AND owner_token=?")
        .run(stamp, jobId, ownerToken);
      this.db.prepare('UPDATE runtime_state SET last_run=? WHERE active_job_id=?').run(stamp, jobId);
      return true;
    });
  }

  private hasWorkflowCheck(jobId: number, name: string, status: string, headSha: string) {
    return !!this.db.prepare(`
      SELECT 1 FROM checks WHERE job_id=? AND name=? AND status=? AND head_sha=?
    `).get(jobId, name, status, headSha.toLowerCase());
  }

  jobIdForOwner(ownerToken: string) {
    const row = asSqlRow<IdRow>(this.db.prepare('SELECT id FROM jobs WHERE owner_token=?').get(ownerToken));
    if (!row) throw new Error('Queue lock ownership changed; no matching job for side effect');
    return Number(row.id);
  }

  ownerProcessIdForOwner(ownerToken: string): number | null {
    const row = asSqlRow<SqlRow>(this.db.prepare("SELECT lease_pid FROM jobs WHERE owner_token=? AND state IN ('CLAIMED','RUNNING')").get(ownerToken));
    if (!row) return null;
    const pid = Number(row.lease_pid);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }

  providerForOwner(ownerToken: string) {
    const row = asSqlRow<SqlRow>(
      this.db.prepare('SELECT provider FROM jobs WHERE owner_token=?').get(ownerToken),
    );
    if (!row || typeof row.provider !== 'string') {
      throw new Error('Queue lock ownership changed; no persisted provider for active job');
    }
    return row.provider;
  }

  beginSideEffect(input: {
    idempotencyKey: string;
    kind: string;
    intent: unknown;
    ownerToken?: string;
  }) {
    if (!input.idempotencyKey || !input.kind) throw new Error('side effect requires an idempotency key and kind');
    const intentJson = JSON.stringify(input.intent);
    if (intentJson === undefined) throw new Error('side-effect intent must be JSON serializable');
    const intentHash = hashPayload(input.intent);
    return this.transaction(() => {
      let jobId: number | null = null;
      if (input.ownerToken) {
        const job = asSqlRow<IdRow>(this.db.prepare(
          "SELECT id FROM jobs WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')",
        ).get(input.ownerToken));
        if (!job) throw new Error('Queue lock ownership changed; refusing side effect');
        jobId = Number(job.id);
      }
      const existing = asSqlRow<SideEffectRow>(this.db.prepare(
        'SELECT * FROM side_effect_journal WHERE idempotency_key=?',
      ).get(input.idempotencyKey));
      if (existing) {
        if (Number(existing.job_id ?? 0) !== Number(jobId ?? 0) || existing.kind !== input.kind ||
            existing.intent_hash !== intentHash) {
          throw new Error(`Side-effect idempotency key collision: ${input.idempotencyKey}`);
        }
        return this.sideEffectValue(existing);
      }
      const stamp = nowIso();
      this.db.prepare(`
        INSERT INTO side_effect_journal(idempotency_key, job_id, kind, intent_hash, intent_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'INTENT', ?, ?)
      `).run(input.idempotencyKey, jobId, input.kind, intentHash, intentJson, stamp, stamp);
      return {
        idempotencyKey: input.idempotencyKey,
        jobId,
        kind: input.kind,
        intent: input.intent,
        status: 'INTENT',
        result: null,
      };
    });
  }

  completeSideEffect(idempotencyKey: string, result: unknown) {
    const resultJson = JSON.stringify(result);
    if (resultJson === undefined) throw new Error('side-effect result must be JSON serializable');
    const updated = this.db.prepare(`
      UPDATE side_effect_journal SET status='COMPLETED', result_json=?, updated_at=?
      WHERE idempotency_key=?
    `).run(resultJson, nowIso(), idempotencyKey);
    if (Number(updated.changes) !== 1) throw new Error(`No side-effect intent exists for ${idempotencyKey}`);
  }

  markSideEffectUncertain(idempotencyKey: string, reason: string) {
    const resultJson = JSON.stringify({ outcome: 'uncertain', reason });
    this.db.prepare(`
      UPDATE side_effect_journal SET status='UNCERTAIN', result_json=?, updated_at=?
      WHERE idempotency_key=? AND status IN ('INTENT', 'UNCERTAIN')
    `).run(resultJson, nowIso(), idempotencyKey);
  }

  markSideEffectPending(idempotencyKey: string) {
    this.db.prepare(`
      UPDATE side_effect_journal SET status='INTENT', result_json=NULL, updated_at=?
      WHERE idempotency_key=? AND status='UNCERTAIN'
    `).run(nowIso(), idempotencyKey);
  }

  sideEffectsForJob(jobId: number) {
    return asSqlRows<SideEffectRow>(this.db.prepare(
      'SELECT * FROM side_effect_journal WHERE job_id=? ORDER BY created_at, idempotency_key',
    ).all(jobId)).map((row) => this.sideEffectValue(row));
  }

  pendingSideEffects() {
    const rows = this.db.prepare(this.sideEffectContextQuery(`e.status IN ('INTENT', 'UNCERTAIN')`))
      .all() as SqlRow[];
    return this.sideEffectContext(rows);
  }

  completedMergeRecoveries() {
    // A normal merge records stage=merged and keeps its lock for `release`.
    // Recovery-stage jobs remain selected until their journaled labels finish.
    const rows = this.db.prepare(this.sideEffectContextQuery(`
      e.kind='merge' AND e.status='COMPLETED'
      AND j.state <> 'RELEASED'
      AND (j.workflow_state <> 'DONE' OR COALESCE(j.stage, '') <> 'merged' OR j.state IN ('READY', 'FAILED'))
    `)).all() as SqlRow[];
    return this.sideEffectContext(rows);
  }

  createAgentSession(input: {
    runner?: string;
    jobId: number;
    externalSessionId: string;
    role: string;
    model: string;
    worktree: string;
    ndjsonPath: string;
    stderrPath: string;
    ociIdentity?: string | null;
  }): PersistedAgentSession {
    if (!Number.isSafeInteger(input.jobId) || input.jobId <= 0 || !input.externalSessionId || !input.role ||
        !input.model || !input.worktree) {
      throw new Error('agent session requires a job, external ID, role, model and worktree');
    }
    const stamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_sessions(job_id, session_id, external_session_id, runner_name, role, model, worktree, oci_identity,
          status, started_at, ndjson_path, stderr_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?)
      `).run(input.jobId, input.externalSessionId, input.externalSessionId, input.runner ?? 'opencode', input.role, input.model,
        input.worktree, input.ociIdentity ?? null, stamp, input.ndjsonPath, input.stderrPath, stamp, stamp);
    });
    const created = this.getAgentSession(input.externalSessionId);
    if (!created) throw new Error(`Could not read newly created agent session ${input.externalSessionId}`);
    return created;
  }

  /**
   * Create a stable, terminal queue-job anchor for a GitHub ticket handoff.
   * Agent sessions require a jobs row for their foreign key, while ticket
   * handoffs have their own lifecycle and must not occupy worker capacity.
   */
  ensureTicketAgentJob(input: { handoffId: string; project: string; issue: number; configFile?: string }): number {
    if (!/^[a-f0-9]{64}$/.test(input.handoffId) || !input.project || !Number.isSafeInteger(input.issue) || input.issue < 1) {
      throw new Error('ticket agent job requires a stable handoff id, project, and positive issue number');
    }
    return this.transaction(() => {
      const externalId = `ticket-handoff:${input.handoffId}`;
      // GitHub project ids are case-insensitive. An alias must find the original
      // job anchor so its persisted agent session remains resumable.
      const prior = asSqlRow<{ id: number }>(this.db.prepare(`
        SELECT j.id FROM jobs j JOIN work_items w ON w.id=j.work_item_id
        WHERE lower(j.project_id)=lower(?) AND w.external_id=? AND j.provider='github' ORDER BY j.id LIMIT 1
      `).get(input.project, externalId));
      if (prior) return Number(prior.id);

      const stamp = nowIso();
      this.upsertProject(input.project, 'github', input.configFile);
      const item = asSqlRow<{ id: number }>(this.db.prepare(`
        INSERT INTO work_items(project_id, external_id, title, url, state, attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'DONE', 1, ?, ?) RETURNING id
      `).get(input.project, externalId, `Ticket handoff for issue #${input.issue}`,
        `https://github.com/${input.project}/issues/${input.issue}`, stamp, stamp));
      if (!item) throw new Error('could not create ticket agent work-item anchor');
      const job = asSqlRow<{ id: number }>(this.db.prepare(`
        INSERT INTO jobs(project_id, work_item_id, config_file, provider, state, stage, attempts, max_attempts,
          release_result, workflow_state, created_at, updated_at)
        VALUES (?, ?, ?, 'github', 'DONE', 'ticket-handoff', 1, 1, 'done', 'DONE', ?, ?) RETURNING id
      `).get(input.project, item.id, input.configFile ? path.resolve(input.configFile) : null, stamp, stamp));
      if (!job) throw new Error('could not create ticket agent job anchor');
      const jobId = Number(job.id);
      this.recordTransition(jobId, null, 'DONE', 'ticket agent session anchor created', 'ticket-runtime', stamp);
      this.db.prepare(`
        INSERT INTO workflow_transitions(job_id, from_state, to_state, reason, actor, created_at)
        VALUES (?, 'NEW', 'DONE', 'ticket handoff lifecycle is persisted separately', 'cli', ?)
      `).run(jobId, stamp);
      return jobId;
    });
  }

  getAgentSession(externalSessionId: string): PersistedAgentSession | null {
    const rows = asSqlRows<AgentSessionRow>(this.db.prepare(
      'SELECT * FROM agent_sessions WHERE external_session_id=? ORDER BY id',
    ).all(externalSessionId));
    if (rows.length > 1) throw new Error(`External agent session ID is ambiguous: ${externalSessionId}`);
    const row = rows[0];
    if (!row || typeof row.external_session_id !== 'string' || typeof row.role !== 'string' ||
        typeof row.model !== 'string' || typeof row.worktree !== 'string' ||
        typeof row.started_at !== 'string' || typeof row.ndjson_path !== 'string' ||
        typeof row.stderr_path !== 'string') return null;
    return {
      id: Number(row.id),
      jobId: Number(row.job_id),
      sessionId: row.session_id,
      externalSessionId: row.external_session_id,
      runner: typeof row.runner_name === 'string' ? row.runner_name : 'opencode',
      role: row.role,
      model: row.model,
      worktree: row.worktree,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      reasoningTokens: Number(row.reasoning_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      costUsd: Number(row.cost_usd),
      resultJson: row.result_json,
      ndjsonPath: row.ndjson_path,
      stderrPath: row.stderr_path,
      errorClass: row.error_class,
      executionOwner: row.execution_owner,
      executionLeaseUntil: row.execution_lease_until,
      executionPid: row.execution_pid == null ? null : Number(row.execution_pid),
      executionPgid: row.execution_pgid == null ? null : Number(row.execution_pgid),
      executionStartTicks: row.execution_start_ticks,
      executionToken: row.execution_token,
      ociIdentity: row.oci_identity,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  agentSessionsForJobRole(jobId: number, role: string): PersistedAgentSession[] {
    const rows = asSqlRows<AgentSessionRow>(this.db.prepare(`
      SELECT * FROM agent_sessions WHERE job_id=? AND role=? ORDER BY id
    `).all(jobId, role));
    const sessions: PersistedAgentSession[] = [];
    for (const row of rows) {
      if (typeof row.external_session_id !== 'string') continue;
      const session = this.getAgentSession(row.external_session_id);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  claimAgentSession(input: {
    externalSessionId: string;
    owner: string;
    leaseUntil: string;
    resume: boolean;
    continueCompleted?: boolean;
  }): AgentSessionClaim {
    const stamp = nowIso();
    return this.transaction(() => {
      const row = asSqlRow<AgentSessionRow>(this.db.prepare(
        'SELECT * FROM agent_sessions WHERE external_session_id=?',
      ).get(input.externalSessionId));
      if (!row) return { acquired: false, reason: 'INVALID_STATE', status: 'MISSING' };

      if (row.status === 'RUNNING') {
        if (!input.resume) return { acquired: false, reason: 'BUSY', status: row.status };
        const leaseExpiry = typeof row.execution_lease_until === 'string'
          ? Date.parse(row.execution_lease_until)
          : Number.NaN;
        if (!Number.isFinite(leaseExpiry)) {
          return { acquired: false, reason: 'INVALID_LEASE', status: row.status };
        }
        if (leaseExpiry > Date.now()) return { acquired: false, reason: 'BUSY', status: row.status };

        const previousProcess = row.execution_pid == null && row.execution_pgid == null &&
          row.execution_start_ticks == null && row.execution_token == null
          ? null
          : {
            pid: row.execution_pid == null ? null : Number(row.execution_pid),
            pgid: row.execution_pgid == null ? null : Number(row.execution_pgid),
            startTicks: row.execution_start_ticks,
            token: row.execution_token,
          };
        this.db.prepare(`
          UPDATE agent_sessions SET execution_owner=?, execution_lease_until=?, updated_at=?
          WHERE external_session_id=? AND status='RUNNING'
        `).run(input.owner, input.leaseUntil, stamp, input.externalSessionId);
        return { acquired: true, recovering: true, previousProcess };
      }

      const completedContinuation = input.resume && input.continueCompleted === true &&
        ['DONE', 'BLOCKED', 'CHANGES_REQUIRED'].includes(row.status);
      if ((!input.resume && row.status !== 'CREATED') || (input.resume && row.status === 'DONE' && !completedContinuation) ||
          (input.resume && ['BLOCKED', 'CHANGES_REQUIRED'].includes(row.status) && !completedContinuation)) {
        return { acquired: false, reason: 'INVALID_STATE', status: row.status };
      }
      this.db.prepare(`
        UPDATE agent_sessions SET status='RUNNING', started_at=?, ended_at=NULL,
          result_json=NULL, error_class=NULL, execution_owner=?, execution_lease_until=?,
          execution_pid=NULL, execution_pgid=NULL, execution_start_ticks=NULL, execution_token=NULL,
          updated_at=? WHERE external_session_id=?
      `).run(stamp, input.owner, input.leaseUntil, stamp, input.externalSessionId);
      return { acquired: true, recovering: false, previousProcess: null };
    });
  }

  renewAgentSessionLease(externalSessionId: string, owner: string, leaseUntil: string) {
    const result = this.db.prepare(`
      UPDATE agent_sessions SET execution_lease_until=?, updated_at=?
      WHERE external_session_id=? AND status='RUNNING' AND execution_owner=?
    `).run(leaseUntil, nowIso(), externalSessionId, owner);
    return Number(result.changes) === 1;
  }

  recordAgentSessionLaunchIntent(input: {
    externalSessionId: string;
    owner: string;
    token: string;
  }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.token)) {
      throw new Error('agent launch intent requires a valid execution token');
    }
    const result = this.db.prepare(`
      UPDATE agent_sessions SET execution_token=?, updated_at=?
      WHERE external_session_id=? AND status='RUNNING' AND execution_owner=?
        AND execution_pid IS NULL AND execution_pgid IS NULL
        AND execution_start_ticks IS NULL AND execution_token IS NULL
    `).run(input.token, nowIso(), input.externalSessionId, input.owner);
    return Number(result.changes) === 1;
  }

  recordAgentSessionProcess(input: {
    externalSessionId: string;
    owner: string;
    pid: number;
    pgid: number;
    startTicks: string;
    token: string;
  }) {
    const result = this.db.prepare(`
      UPDATE agent_sessions SET execution_pid=?, execution_pgid=?, execution_start_ticks=?, updated_at=?
      WHERE external_session_id=? AND status='RUNNING' AND execution_owner=?
        AND execution_pid IS NULL AND execution_pgid IS NULL AND execution_start_ticks IS NULL
        AND execution_token=?
    `).run(input.pid, input.pgid, input.startTicks, nowIso(), input.externalSessionId, input.owner, input.token);
    return Number(result.changes) === 1;
  }

  clearAgentSessionProcess(externalSessionId: string, owner: string) {
    const result = this.db.prepare(`
      UPDATE agent_sessions SET execution_pid=NULL, execution_pgid=NULL, execution_start_ticks=NULL,
        execution_token=NULL, updated_at=?
      WHERE external_session_id=? AND status='RUNNING' AND execution_owner=?
    `).run(nowIso(), externalSessionId, owner);
    return Number(result.changes) === 1;
  }

  completeAgentSession(input: {
    externalSessionId: string;
    owner: string;
    status: 'DONE' | 'BLOCKED' | 'CHANGES_REQUIRED' | 'NEEDS_INFO';
    result: unknown;
    usage: AgentUsage;
  }) {
    const resultJson = JSON.stringify(input.result);
    if (resultJson === undefined) throw new Error('agent result must be JSON serializable');
    this.assertAgentUsage(input.usage);
    const stamp = nowIso();
    const updated = this.db.prepare(`
      UPDATE agent_sessions SET status=?, ended_at=?, result_json=?, error_class=NULL,
        input_tokens=input_tokens+?, output_tokens=output_tokens+?, reasoning_tokens=reasoning_tokens+?,
        cache_read_tokens=cache_read_tokens+?, cache_write_tokens=cache_write_tokens+?, cost_usd=cost_usd+?,
        execution_owner=NULL, execution_lease_until=NULL, execution_pid=NULL, execution_pgid=NULL,
        execution_start_ticks=NULL, execution_token=NULL, updated_at=?
      WHERE external_session_id=? AND status='RUNNING' AND execution_owner=?
    `).run(input.status, stamp, resultJson, input.usage.inputTokens, input.usage.outputTokens,
      input.usage.reasoningTokens, input.usage.cacheReadTokens, input.usage.cacheWriteTokens,
      input.usage.costUsd, stamp, input.externalSessionId, input.owner);
    if (Number(updated.changes) !== 1) throw new Error(`Agent session execution ownership was lost: ${input.externalSessionId}`);
  }

  failAgentSession(input: {
    externalSessionId: string;
    owner: string;
    status: 'FAILED' | 'ABORTED';
    errorClass: string;
    usage: AgentUsage;
  }) {
    if (!input.errorClass) throw new Error('failed agent session requires an error class');
    this.assertAgentUsage(input.usage);
    const stamp = nowIso();
    const updated = this.db.prepare(`
      UPDATE agent_sessions SET status=?, ended_at=?, result_json=NULL, error_class=?,
        input_tokens=input_tokens+?, output_tokens=output_tokens+?, reasoning_tokens=reasoning_tokens+?,
        cache_read_tokens=cache_read_tokens+?, cache_write_tokens=cache_write_tokens+?, cost_usd=cost_usd+?,
        execution_owner=NULL, execution_lease_until=NULL, execution_pid=NULL, execution_pgid=NULL,
        execution_start_ticks=NULL, execution_token=NULL, updated_at=?
      WHERE external_session_id=? AND status='RUNNING' AND execution_owner=?
    `).run(input.status, stamp, input.errorClass, input.usage.inputTokens, input.usage.outputTokens,
      input.usage.reasoningTokens, input.usage.cacheReadTokens, input.usage.cacheWriteTokens,
      input.usage.costUsd, stamp, input.externalSessionId, input.owner);
    if (Number(updated.changes) !== 1) throw new Error(`Agent session execution ownership was lost: ${input.externalSessionId}`);
  }

  private assertAgentUsage(usage: AgentUsage) {
    for (const [name, value] of Object.entries(usage)) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`agent usage ${name} must be a finite non-negative number`);
    }
  }

  private sideEffectContextQuery(where: string) {
    return `
      SELECT e.*, j.owner_token, j.project_id AS job_project, j.config_file AS job_config_file,
        j.provider AS job_provider, j.workflow_state AS job_workflow_state, j.state AS job_state,
        j.error_class AS job_error_class, j.branch AS job_branch, j.head_sha AS job_head_sha,
        j.change_number AS job_change_number, w.external_id AS job_issue
      FROM side_effect_journal e LEFT JOIN jobs j ON j.id=e.job_id
        LEFT JOIN work_items w ON w.id=j.work_item_id
      WHERE ${where}
      ORDER BY e.created_at, e.idempotency_key
    `;
  }

  private sideEffectContext(rows: SqlRow[]) {
    return rows.map((raw) => {
      const row = raw as unknown as SideEffectRow;
      const effect = this.sideEffectValue(row);
      const intent = effect.intent as Record<string, unknown>;
      const project = typeof intent.project === 'string'
        ? intent.project
        : typeof raw.job_project === 'string' ? raw.job_project : null;
      const projectConfig = project
        ? asSqlRow<SqlRow>(this.db.prepare('SELECT provider, config_file FROM projects WHERE id=?').get(project))
        : undefined;
      return {
        ...effect,
        ownerToken: typeof raw.owner_token === 'string' ? raw.owner_token : null,
        project,
        provider: typeof raw.job_provider === 'string'
          ? raw.job_provider
          : typeof projectConfig?.provider === 'string' ? projectConfig.provider : null,
        configFile: typeof raw.job_config_file === 'string'
          ? raw.job_config_file
          : typeof intent.config_file === 'string' ? intent.config_file
            : typeof projectConfig?.config_file === 'string' ? projectConfig.config_file : null,
        issue: typeof raw.job_issue === 'string' ? Number(raw.job_issue) : null,
        branch: typeof raw.job_branch === 'string' ? raw.job_branch : null,
        headSha: typeof raw.job_head_sha === 'string' ? raw.job_head_sha : null,
        changeNumber: raw.job_change_number == null ? null : Number(raw.job_change_number),
        workflowState: typeof raw.job_workflow_state === 'string' ? raw.job_workflow_state : null,
        jobState: typeof raw.job_state === 'string' ? raw.job_state : null,
        errorClass: typeof raw.job_error_class === 'string' ? raw.job_error_class : null,
      };
    });
  }

  prepareMergedSideEffectRecovery(idempotencyKey: string, observed: {
    project: string;
    number: number;
    head_sha: string;
    issue: number;
    branch: string;
    base: string;
  }, limits: { maxConcurrency?: number; projectConcurrency?: number; resourceLocks?: string[] } = {}) {
    assertResourceLocks(limits.resourceLocks);
    return this.transaction(() => {
      const row = asSqlRow<SqlRow>(this.db.prepare(`
        SELECT e.job_id, e.kind, e.status, e.intent_json,
          j.state AS job_state, j.owner_token, j.workflow_state, j.error_class, j.work_item_id,
          j.project_id, j.branch, j.head_sha, j.change_number, j.stage, j.config_file,
          j.provider, j.account, j.local_only, j.claimed_by, j.claimed_at, j.lease_pid, j.lease_start_ticks,
          w.external_id, w.state AS item_state
        FROM side_effect_journal e JOIN jobs j ON j.id=e.job_id
        JOIN work_items w ON w.id=j.work_item_id
        WHERE e.idempotency_key=?
      `).get(idempotencyKey));
      if (!row || row.kind !== 'merge' || !['INTENT', 'UNCERTAIN', 'COMPLETED'].includes(String(row.status))) {
        throw new Error('merge recovery intent changed; refusing workflow recovery');
      }
      const intent = JSON.parse(String(row.intent_json)) as Record<string, unknown>;
      const jobId = Number(row.job_id);
      const workItemId = Number(row.work_item_id);
      const issue = Number(row.external_id);
      const headSha = String(row.head_sha ?? '').toLowerCase();
      if (typeof row.config_file !== 'string' || !row.config_file ||
          observed.project !== row.project_id || intent.project !== row.project_id ||
          Number(observed.number) !== Number(row.change_number) ||
          Number(intent.number) !== Number(row.change_number) || observed.head_sha.toLowerCase() !== headSha ||
          String(intent.head_sha ?? '').toLowerCase() !== headSha || Number(observed.issue) !== issue ||
          Number(intent.issue) !== issue || typeof row.branch !== 'string' || observed.branch !== row.branch ||
          intent.branch !== row.branch || typeof intent.base !== 'string' || !intent.base ||
          observed.base !== intent.base || typeof intent.owner_token !== 'string' || !intent.owner_token) {
        throw new Error('observed merge does not match the persisted job and merge intent');
      }

      const jobState = String(row.job_state);
      const workflow = String(row.workflow_state);
      const recoveryStage = row.stage === 'merge-recovery';
      const doneRecovery = workflow === 'DONE' && (recoveryStage || row.stage !== 'merged' ||
        jobState === 'READY' || jobState === 'FAILED');
      if (workflow === 'DONE' && !doneRecovery) return null;
      if (workflow !== 'MERGING' && workflow !== 'DONE' &&
          !(workflow === 'FAILED' && row.error_class === 'LeaseExpiredMaxAttempts')) return null;
      if (jobState === 'RELEASED') return null;
      if (!['CLAIMED', 'RUNNING', 'READY', 'FAILED'].includes(jobState)) return null;
      if (jobState === 'FAILED' && row.error_class !== 'LeaseExpiredMaxAttempts') return null;

      let ownerToken: string;
      if (jobState === 'CLAIMED' || jobState === 'RUNNING') {
        if (processOwnerAlive(Number(row.lease_pid), row.lease_start_ticks) !== false) return null;
        if (!recoveryStage && row.owner_token !== intent.owner_token) return null;
        if (typeof row.owner_token !== 'string' || !row.owner_token) return null;
        ownerToken = row.owner_token;
      } else {
        if (row.owner_token != null) return null;
        ownerToken = randomUUID();
      }

      const stamp = nowIso();
      const leaseExpiresAt = new Date(Date.parse(stamp) + DEFAULT_LEASE_MS).toISOString();
      const globalCap = limits.maxConcurrency ?? 1;
      const projectCap = limits.projectConcurrency ?? globalCap;
      if (!Number.isSafeInteger(globalCap) || globalCap < 1 || !Number.isSafeInteger(projectCap) || projectCap < 1 || projectCap > globalCap) {
        throw new Error('recovery capacity limits must be positive integers and project capacity cannot exceed global capacity');
      }
      const active = Number(asSqlRow<CountRow>(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('CLAIMED','RUNNING')").get())?.count ?? 0);
      const provider = String(row.provider);
      const projectPredicate = githubProjectPredicate('j.project_id', provider);
      const projectActive = Number(asSqlRow<CountRow>(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs j WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', provider)} AND j.state IN ('CLAIMED','RUNNING')`).get(row.project_id))?.count ?? 0);
      const globalLimit = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_global_limit WHERE singleton=1').get());
       const activeProjectRows = asSqlRows<SqlRow>(this.db.prepare(`SELECT config_file,project_id FROM jobs j WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', provider)} AND j.state IN ('CLAIMED','RUNNING')`).all(row.project_id));
       const projectLimitMismatch = activeProjectRows.some((activeRow) => {
         const cap = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_project_caps WHERE config_file=? AND project_id=?').get(activeRow.config_file, activeRow.project_id));
         return (cap ? Number(cap.max_concurrency) : 1) !== projectCap;
       });
       if (active > globalCap || projectActive > projectCap ||
           (active > 0 && Number(globalLimit?.max_concurrency ?? 1) !== globalCap) || projectLimitMismatch) return null;
      const heldResources = new Set(this.db.prepare('SELECT resource FROM job_resource_locks WHERE job_id=? AND owner_token=?').all(jobId, String(row.owner_token))
        .map((lock) => String((lock as SqlRow).resource)));
      const missingResources = (limits.resourceLocks ?? []).filter((resource) => !heldResources.has(resource));
      for (const resource of missingResources) {
        if (this.db.prepare('SELECT 1 FROM job_resource_locks WHERE resource=?').get(resource)) return null;
      }
      if (jobState === 'READY' || jobState === 'FAILED') {
        if (active >= globalCap || projectActive >= projectCap ||
            (active > 0 && Number(globalLimit?.max_concurrency ?? 1) !== globalCap) ||
            projectLimitMismatch) return null;
        const claimed = this.db.prepare(`
          UPDATE jobs SET state='CLAIMED', owner_token=?, stage='merge-recovery', claimed_by=?, lease_pid=?, lease_start_ticks=?,
            claimed_at=?, heartbeat_at=?, lease_expires_at=?, error_class=NULL, updated_at=?
          WHERE id=? AND state=?
        `).run(ownerToken, String(process.pid), process.pid, processStartTicks(process.pid), stamp, stamp, leaseExpiresAt, stamp, jobId, jobState);
        if (Number(claimed.changes) !== 1) return null;
        for (const resource of missingResources) {
          this.db.prepare('INSERT INTO job_resource_locks(resource,job_id,owner_token,lease_expires_at) VALUES (?,?,?,?)')
            .run(resource, jobId, ownerToken, leaseExpiresAt);
        }
        this.db.prepare('INSERT INTO scheduler_global_limit(singleton,max_concurrency) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(globalCap);
        this.db.prepare('INSERT INTO scheduler_config(config_file,max_concurrency) VALUES (?,?) ON CONFLICT(config_file) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(path.resolve(row.config_file), globalCap);
        this.db.prepare('INSERT INTO scheduler_project_caps(config_file,project_id,max_concurrency) VALUES (?,?,?) ON CONFLICT(config_file,project_id) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(path.resolve(row.config_file), row.project_id, projectCap);
        this.db.prepare("UPDATE work_items SET state='CLAIMED', updated_at=? WHERE id=?")
          .run(stamp, workItemId);
        this.recordTransition(jobId, jobState, 'CLAIMED', 'verified merge recovery claimed for journaled label finalization', 'merge-reconciler', stamp);
      } else {
        for (const resource of missingResources) {
          this.db.prepare('INSERT INTO job_resource_locks(resource,job_id,owner_token,lease_expires_at) VALUES (?,?,?,?)')
            .run(resource, jobId, ownerToken, leaseExpiresAt);
        }
        const refreshed = this.db.prepare(`
          UPDATE jobs SET stage='merge-recovery', claimed_by=?, lease_pid=?, lease_start_ticks=?, heartbeat_at=?, lease_expires_at=?, updated_at=?
          WHERE id=? AND owner_token=? AND state IN ('CLAIMED', 'RUNNING')
        `).run(String(process.pid), process.pid, processStartTicks(process.pid), stamp, leaseExpiresAt, stamp, jobId, ownerToken);
        if (Number(refreshed.changes) !== 1) return null;
      }
      this.db.prepare('UPDATE job_resource_locks SET lease_expires_at=? WHERE job_id=? AND owner_token=?')
        .run(leaseExpiresAt, jobId, ownerToken);

      if (!this.hasWorkflowCheck(jobId, 'merge', 'merged', headSha)) {
        this.db.prepare(`
          INSERT INTO checks(job_id, name, status, head_sha, details_json, checked_at)
          VALUES (?, 'merge', 'merged', ?, ?, ?)
        `).run(jobId, headSha, JSON.stringify({ change: observed.number, issue, branch: observed.branch,
          base: observed.base, reconciled: true }), stamp);
      }
      if (workflow === 'MERGING') {
        this.transitionWorkflowInTransaction(jobId, 'DONE', 'cli', 'exact merged PR recovered from the durable merge intent');
      } else if (workflow === 'FAILED') {
        this.db.prepare("UPDATE jobs SET workflow_state='DONE', updated_at=? WHERE id=?").run(stamp, jobId);
        this.db.prepare(`
          INSERT INTO workflow_transitions(job_id, from_state, to_state, reason, actor, created_at)
          VALUES (?, 'FAILED', 'DONE', ?, 'cli', ?)
        `).run(jobId, 'exact merged PR recovered after lease exhaustion', stamp);
      }

      this.db.prepare(`
        INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)
        ON CONFLICT(config_file) DO UPDATE SET active_job_id=CASE
          WHEN runtime_state.active_job_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM jobs WHERE id=runtime_state.active_job_id AND state IN ('CLAIMED','RUNNING')
          ) THEN runtime_state.active_job_id ELSE excluded.active_job_id END,
          last_run=excluded.last_run
      `).run(path.resolve(String(row.config_file)), jobId, stamp);
      this.db.prepare(`
        UPDATE side_effect_journal SET status='COMPLETED', result_json=?, updated_at=?
        WHERE idempotency_key=?
      `).run(JSON.stringify({ outcome: 'startup-merge-reconciled', observed }), stamp, idempotencyKey);
      return fromRow(asSqlRow<LockRow>(this.db.prepare(`
        SELECT j.*, w.external_id FROM jobs j JOIN work_items w ON w.id=j.work_item_id WHERE j.id=?
      `).get(jobId)));
    });
  }

  finalizeMergedRecovery(ownerToken: string, mergeKey: string, requiredLabelKeys: string[]) {
    return this.transaction(() => {
      const row = asSqlRow<SqlRow>(this.db.prepare(`
        SELECT j.id, j.state, j.workflow_state, j.stage, j.owner_token, j.work_item_id, j.project_id,
          j.head_sha, j.config_file
        FROM jobs j WHERE j.owner_token=? AND j.state IN ('CLAIMED', 'RUNNING')
      `).get(ownerToken));
      if (!row || row.workflow_state !== 'DONE' || row.stage !== 'merge-recovery') return false;
      const jobId = Number(row.id);
      if (!this.hasWorkflowCheck(jobId, 'merge', 'merged', String(row.head_sha ?? ''))) return false;
      const merge = asSqlRow<SqlRow>(this.db.prepare(`
        SELECT job_id, kind, status FROM side_effect_journal WHERE idempotency_key=?
      `).get(mergeKey));
      if (!merge || Number(merge.job_id) !== jobId || merge.kind !== 'merge' || merge.status !== 'COMPLETED') return false;
      for (const key of requiredLabelKeys) {
        const effect = asSqlRow<SqlRow>(this.db.prepare(`
          SELECT job_id, kind, status FROM side_effect_journal WHERE idempotency_key=?
        `).get(key));
        if (!effect || Number(effect.job_id) !== jobId || effect.status !== 'COMPLETED' ||
            !['issue-label-add', 'issue-label-remove'].includes(String(effect.kind))) return false;
      }
      const stamp = nowIso();
      this.db.prepare(`
        UPDATE jobs SET state='RELEASED', owner_token=NULL, lease_expires_at=NULL,
          stage='merged', release_result='done', error_class=NULL, updated_at=? WHERE id=?
      `).run(stamp, jobId);
      this.recordTransition(jobId, String(row.state), 'RELEASED',
        'verified merge recovery completed after journaled labels', 'merge-reconciler', stamp);
      this.db.prepare("UPDATE work_items SET state='DONE', updated_at=? WHERE id=?")
        .run(stamp, row.work_item_id);
      this.db.prepare('DELETE FROM job_resource_locks WHERE job_id=? AND owner_token=?').run(jobId, ownerToken);
      this.db.prepare('UPDATE runtime_state SET active_job_id=NULL, last_run=? WHERE active_job_id=?')
        .run(stamp, jobId);
      this.db.prepare("DELETE FROM scheduler_global_limit WHERE singleton=1 AND NOT EXISTS (SELECT 1 FROM jobs WHERE state IN ('CLAIMED','RUNNING'))").run();
      return true;
    });
  }

  private sideEffectValue(row: SideEffectRow) {
    return {
      idempotencyKey: row.idempotency_key,
      jobId: row.job_id == null ? null : Number(row.job_id),
      kind: row.kind,
      intent: JSON.parse(row.intent_json),
      status: row.status,
      result: row.result_json == null ? null : JSON.parse(row.result_json),
    };
  }

  resumeLock(previousToken: string, lock: Lock, limits: { maxConcurrency?: number; projectConcurrency?: number; resourceLocks?: string[] } = {}) {
    assertResourceLocks(limits.resourceLocks);
    return this.transaction(() => {
      const before = asSqlRow<IdRow & { lease_pid?: unknown; lease_start_ticks?: unknown; project_id: string; config_file?: string | null }>(
        this.db.prepare("SELECT id, lease_pid, lease_start_ticks, project_id, config_file FROM jobs WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')").get(previousToken),
      );
      if (!before) throw new Error('Queue lock ownership changed; refusing to resume another run');
      const pid = Number(before.lease_pid);
      // Explicit stale confirmation permits recovery of legacy rows without a PID;
      // a known live or ambiguous PID must still never be stolen.
      if (Number.isSafeInteger(pid) && pid > 0 && processOwnerAlive(pid, before.lease_start_ticks) !== false) {
        throw new Error('Prior run process is still live or cannot be safely identified; refusing stale recovery');
      }
      const globalCap = limits.maxConcurrency ?? 1;
      const projectCap = limits.projectConcurrency ?? globalCap;
      if (!Number.isSafeInteger(globalCap) || globalCap < 1 || !Number.isSafeInteger(projectCap) || projectCap < 1 || projectCap > globalCap)
        throw new Error('resume capacity limits must be positive integers and project capacity cannot exceed global capacity');
      const activeCount = Number(asSqlRow<CountRow>(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('CLAIMED','RUNNING')").get())?.count ?? 0);
      const storedGlobal = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_global_limit WHERE singleton=1').get());
      if (storedGlobal && Number(storedGlobal.max_concurrency) !== globalCap) throw new Error('Active configurations sharing ISSUE_ORCHESTRATOR_HOME must use the same max_concurrency');
      const activeConfigs = asSqlRows<SqlRow>(this.db.prepare("SELECT DISTINCT config_file FROM jobs WHERE state IN ('CLAIMED','RUNNING') AND config_file IS NOT NULL").all());
      for (const activeConfig of activeConfigs) {
        const configured = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_config WHERE config_file=?').get(activeConfig.config_file));
        if (configured && Number(configured.max_concurrency) !== globalCap) throw new Error('Active configurations sharing ISSUE_ORCHESTRATOR_HOME must use the same max_concurrency');
      }
      if (activeCount > globalCap) throw new Error(`Global run capacity is full (${activeCount}/${globalCap})`);
      const projectPredicate = githubProjectPredicate('j.project_id', lock.provider);
      const projectCount = Number(asSqlRow<CountRow>(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs j WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', lock.provider)} AND state IN ('CLAIMED','RUNNING')`).get(lock.repo))?.count ?? 0);
       const activeProjectRows = asSqlRows<SqlRow>(this.db.prepare(`SELECT config_file,project_id FROM jobs j WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', lock.provider)} AND state IN ('CLAIMED','RUNNING')`).all(lock.repo));
       for (const activeRow of activeProjectRows) {
         const configured = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_project_caps WHERE config_file=? AND project_id=?').get(activeRow.config_file, activeRow.project_id));
         if ((configured ? Number(configured.max_concurrency) : 1) !== projectCap)
           throw new Error(`Active configurations sharing project ${lock.repo} must use the same project concurrency cap`);
       }
      if (projectCount > projectCap) throw new Error(`Project run capacity is full for ${lock.repo}`);
      const leaseUntil = new Date(Date.now() + DEFAULT_LEASE_MS).toISOString();
      for (const resource of [...new Set(limits.resourceLocks ?? [])]) {
        const owned = this.db.prepare('SELECT 1 FROM job_resource_locks WHERE resource=? AND job_id=? AND owner_token=?').get(resource, before.id, previousToken);
        if (!owned) {
          const reserved = this.db.prepare('INSERT OR IGNORE INTO job_resource_locks(resource,job_id,owner_token,lease_expires_at) VALUES (?,?,?,?)').run(resource, before.id, lock.owner_token, leaseUntil);
          if (Number(reserved.changes) !== 1) throw new Error(`Resource lock is busy: ${resource}`);
        }
      }
      if (lock.config_file) {
        const configPath = path.resolve(lock.config_file);
        this.db.prepare('INSERT INTO scheduler_config(config_file,max_concurrency) VALUES (?,?) ON CONFLICT(config_file) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(configPath, globalCap);
        this.db.prepare('INSERT INTO scheduler_project_caps(config_file,project_id,max_concurrency) VALUES (?,?,?) ON CONFLICT(config_file,project_id) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(configPath, lock.repo, projectCap);
      }
      this.db.prepare('INSERT INTO scheduler_global_limit(singleton,max_concurrency) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(globalCap);
      const resumed = this.db.prepare(`
        UPDATE jobs SET owner_token=?, config_file=?, account=?, resumed_at=?, heartbeat_at=?, lease_expires_at=?, lease_pid=?, lease_start_ticks=?, claimed_by=?, updated_at=?
        WHERE id=? AND owner_token=? AND state IN ('CLAIMED','RUNNING')
      `).run(lock.owner_token, path.resolve(lock.config_file), lock.account ?? null, lock.resumed_at,
        nowIso(), leaseUntil, process.pid, processStartTicks(process.pid), String(process.pid), lock.updated_at, before.id, previousToken);
      if (Number(resumed.changes) !== 1) throw new Error('Queue lock ownership changed; refusing to resume another run');
      this.db.prepare('UPDATE job_resource_locks SET owner_token=?, lease_expires_at=? WHERE job_id=? AND owner_token=?')
        .run(lock.owner_token, leaseUntil, before.id, previousToken);
      this.recordTransition(Number(before.id), 'CLAIMED', 'CLAIMED', 'ownership resumed', lock.owner_token, lock.updated_at);
      this.db.prepare(`
        INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)
        ON CONFLICT(config_file) DO UPDATE SET active_job_id=CASE
          WHEN runtime_state.active_job_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM jobs WHERE id=runtime_state.active_job_id AND state IN ('CLAIMED','RUNNING')
          ) THEN runtime_state.active_job_id ELSE excluded.active_job_id END,
          last_run=excluded.last_run
      `).run(path.resolve(lock.config_file), before.id, lock.updated_at);
      return lock;
    });
  }

  clearLock(ownerToken?: string, result = 'none') {
    return this.transaction(() => {
      const current = ownerToken
        ? fromRow(asSqlRow<LockRow>(this.db.prepare(`SELECT j.*, w.external_id FROM jobs j JOIN work_items w ON w.id=j.work_item_id
            WHERE j.owner_token=? AND j.state IN ('CLAIMED','RUNNING')`).get(ownerToken)))
        : this.readLock();
      if (!current) {
        if (ownerToken) throw new Error('Queue lock ownership changed; refusing to clear another run\'s lock');
        return false;
      }
      if (ownerToken && current.owner_token !== ownerToken) {
        throw new Error('Queue lock ownership changed; refusing to clear another run\'s lock');
      }
      const state = result === 'done' ? 'DONE' : result === 'blocked' ? 'BLOCKED' : result === 'review' ? 'REVIEW' :
        result === 'needs-info' ? 'NEEDS_INFO' : 'READY';
      if (result !== 'none') {
        const workflow = asSqlRow<SqlRow>(this.db.prepare('SELECT workflow_state FROM jobs WHERE owner_token=?').get(current.owner_token));
        if (workflow?.workflow_state !== state) {
          throw new Error(`Cannot release with ${result}: workflow outcome is ${String(workflow?.workflow_state ?? 'unknown')}`);
        }
      }
      this.finishActiveJob(current.owner_token, 'RELEASED', `released: ${result}`, state);
      return true;
    });
  }

  private finishActiveJob(ownerToken: string, finalState: string, reason: string, itemState = 'READY') {
    const row = asSqlRow<FinishingJobRow>(
      this.db.prepare("SELECT id, work_item_id, project_id, provider, state, config_file FROM jobs WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')")
        .get(ownerToken),
    );
    if (!row) return false;
    const stamp = nowIso();
      this.db.prepare("UPDATE jobs SET state=?, lease_expires_at=NULL, updated_at=? WHERE id=? AND state IN ('CLAIMED', 'RUNNING')")
        .run(finalState, stamp, row.id);
      this.db.prepare('DELETE FROM job_resource_locks WHERE job_id=? AND owner_token=?').run(row.id, ownerToken);
    this.db.prepare('UPDATE work_items SET state=?, updated_at=? WHERE id=?').run(itemState, stamp, row.work_item_id);
    this.recordTransition(Number(row.id), row.state, finalState, reason, ownerToken, stamp);
    if (row.config_file) {
      this.db.prepare('UPDATE runtime_state SET active_job_id=NULL, last_run=? WHERE config_file=? AND active_job_id=?')
        .run(stamp, row.config_file, row.id);
    }
    this.db.prepare("DELETE FROM scheduler_global_limit WHERE singleton=1 AND NOT EXISTS (SELECT 1 FROM jobs WHERE state IN ('CLAIMED','RUNNING'))").run();
      this.clearProjectCapacityIfIdle(row.project_id, row.provider);
    return true;
  }

  private recordTransition(jobId: number, from: string | null, to: string, reason: string, actor: string, at = nowIso()) {
    this.db.prepare(`
      INSERT INTO job_transitions(job_id, from_state, to_state, reason, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, from, to, reason, actor, at);
  }

  /** Enqueue an event once, even if its provider delivery is redelivered. */
  recordEventAndEnqueue(event: {
    project: string;
    provider: string;
    kind: string;
    payload: unknown;
    deliveryId?: string | null;
    workItemId: string | number;
    title?: string;
    author?: string;
    url?: string;
  }) {
    return this.transaction(() => {
      const stamp = nowIso();
      const payloadHash = hashPayload(event.payload);
      let project = event.project;
      if (isGitHubTracker(event.provider)) {
        const existing = asSqlRows<SqlRow>(this.db.prepare(`
          SELECT project_id AS id FROM (
            SELECT j.project_id FROM jobs j WHERE lower(j.project_id)=lower(?)
              AND substr(j.provider,1,instr(j.provider||'+','+')-1)='github'
            UNION SELECT e.project_id FROM events e WHERE lower(e.project_id)=lower(?)
              AND substr(e.provider,1,instr(e.provider||'+','+')-1)='github'
            UNION SELECT p.id FROM projects p WHERE lower(p.id)=lower(?)
              AND substr(p.provider,1,instr(p.provider||'+','+')-1)='github'
              AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.project_id=p.id)
              AND NOT EXISTS (SELECT 1 FROM events e WHERE e.project_id=p.id)
          ) ORDER BY project_id
        `).all(event.project, event.project, event.project));
        if (existing.length > 1) {
          throw new Error(`Ambiguous GitHub project identity for ${event.project}: ${existing.map((row) => String(row.id)).join(', ')}`);
        }
        if (existing.length === 1) project = String(existing[0].id);
      }
      const dedupeKey = event.deliveryId
        ? `${event.provider}:delivery:${event.deliveryId}`
        : `${project}:${event.workItemId}:${event.kind}:${payloadHash}`;
      this.upsertProject(project, event.provider);
      const item = asSqlRow<EventWorkItemRow>(this.db.prepare(`
        INSERT INTO work_items(project_id, external_id, title, author, url, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'READY', ?, ?)
        ON CONFLICT(project_id, external_id) DO UPDATE SET
          title=COALESCE(excluded.title, work_items.title), author=COALESCE(excluded.author, work_items.author),
          url=COALESCE(excluded.url, work_items.url), updated_at=excluded.updated_at
        RETURNING id, state
      `).get(project, String(event.workItemId), event.title ?? null, event.author ?? null, event.url ?? null, stamp, stamp));
      if (!item) throw new Error(`Could not persist event work item ${project}#${event.workItemId}`);
      const payloadJson = JSON.stringify(event.payload);
      if (payloadJson === undefined) throw new Error('event payload must be JSON serializable');
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO events(project_id, work_item_id, provider, delivery_id, dedupe_key, kind,
          payload_hash, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(project, item.id, event.provider, event.deliveryId ?? null, dedupeKey, event.kind,
        payloadHash, payloadJson, stamp);
      const eventRow = asSqlRow<EventIdRow>(
        this.db.prepare('SELECT id FROM events WHERE dedupe_key=? OR (provider=? AND delivery_id=?) LIMIT 1')
          .get(dedupeKey, event.provider, event.deliveryId ?? null),
      );
      if (!eventRow) throw new Error('Could not read the persisted event');
      if (Number(inserted.changes) > 0 && item.state === 'READY') {
        const queued = asSqlRow<EventIdRow>(this.db.prepare(`
          INSERT OR IGNORE INTO jobs(project_id, work_item_id, event_id, provider, state, workflow_state, attempts, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'READY', 'READY', 0, ?, ?) RETURNING id
        `).get(project, item.id, eventRow.id, event.provider, stamp, stamp));
        if (queued) this.recordTransition(Number(queued.id), null, 'READY', 'event enqueued', event.provider, stamp);
      }
      return {
        inserted: Number(inserted.changes) > 0,
        eventId: Number(eventRow.id),
        job: asSqlRow<EventStateRow>(this.db.prepare('SELECT id, state FROM jobs WHERE event_id=?').get(eventRow.id)) ?? null,
      };
    });
  }

  /** Atomic worker claim; competing processes observe only one READY -> CLAIMED update. */
  claimWorkItem(project: string, workItemId: string | number, options: {
    provider?: string;
    workerId?: string;
    ownerToken?: string;
    leaseMs?: number;
    maxAttempts?: number;
    configFile?: string;
    maxConcurrency?: number;
    projectConcurrency?: number;
    resourceLocks?: string[];
    processId?: number | null;
  } = {}) {
    assertResourceLocks(options.resourceLocks);
    const provider = options.provider ?? 'github';
    const projectPredicate = githubProjectPredicate('j.project_id', provider);
    return this.transaction(() => {
      this.reapExpiredInTransaction(Date.now());
      const globalCap = options.maxConcurrency ?? 1;
      const projectCap = options.projectConcurrency ?? globalCap;
      if (!Number.isSafeInteger(globalCap) || globalCap < 1 || !Number.isSafeInteger(projectCap) || projectCap < 1 || projectCap > globalCap) {
        throw new Error('claim capacity limits must be positive integers and project capacity cannot exceed global capacity');
      }
      const activeCount = Number(asSqlRow<CountRow>(this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('CLAIMED','RUNNING')").get())?.count ?? 0);
      const storedGlobal = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_global_limit WHERE singleton=1').get());
      if (activeCount > 0 && !storedGlobal && globalCap !== 1) throw new Error('Legacy active jobs use the default max_concurrency=1 until released');
      if (activeCount > 0 && storedGlobal && Number(storedGlobal.max_concurrency) !== globalCap) throw new Error('Active configurations sharing ISSUE_ORCHESTRATOR_HOME must use the same max_concurrency');
      const activeConfigs = asSqlRows<SqlRow>(this.db.prepare("SELECT DISTINCT config_file FROM jobs WHERE state IN ('CLAIMED','RUNNING') AND config_file IS NOT NULL").all());
      for (const activeConfig of activeConfigs) {
        const prior = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_config WHERE config_file=?').get(activeConfig.config_file));
        if (!prior || Number(prior.max_concurrency) !== globalCap) throw new Error('Active configurations sharing ISSUE_ORCHESTRATOR_HOME must use the same max_concurrency');
      }
      if (activeCount >= globalCap) return null;
      const duplicateOwner = this.db.prepare(`SELECT 1 FROM jobs j JOIN work_items w ON w.id=j.work_item_id
        WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', provider)} AND w.external_id=? AND j.state IN ('CLAIMED','RUNNING') LIMIT 1`).get(project, String(workItemId));
      if (duplicateOwner) return null;
      const projectCount = Number(asSqlRow<CountRow>(this.db.prepare(`SELECT COUNT(*) AS count FROM jobs j WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', provider)} AND j.state IN ('CLAIMED','RUNNING')`).get(project))?.count ?? 0);
      if (options.configFile) this.clearInactiveProjectConfigCap(path.resolve(options.configFile), project, provider);
       const activeProjectRows = asSqlRows<SqlRow>(this.db.prepare(`SELECT config_file,project_id FROM jobs j WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', provider)} AND j.state IN ('CLAIMED','RUNNING')`).all(project));
       for (const activeRow of activeProjectRows) {
         const prior = asSqlRow<SqlRow>(this.db.prepare('SELECT max_concurrency FROM scheduler_project_caps WHERE config_file=? AND project_id=?').get(activeRow.config_file, activeRow.project_id));
         if ((prior ? Number(prior.max_concurrency) : 1) !== projectCap) throw new Error(`Active configurations sharing project ${project} must use the same project concurrency cap`);
       }
      if (projectCount >= projectCap) return null;
      const stamp = nowIso();
      if (isGitHubTracker(provider)) {
        const legacyIdentity = this.db.prepare(`SELECT 1 FROM work_items w JOIN jobs j ON j.work_item_id=w.id
          WHERE lower(w.project_id)=lower(?) AND w.external_id=? AND w.project_id<>?
            AND ${trackerProviderPredicate('j', provider)} LIMIT 1`)
          .get(project, String(workItemId), project);
        // Don't create a second queue row for an older mixed-case identity;
        // safely mapping its workflow/retry history requires an explicit migration.
        if (legacyIdentity) return null;
        const exhausted = this.db.prepare(`SELECT 1 FROM jobs j JOIN work_items w ON w.id=j.work_item_id
          WHERE ${projectPredicate} AND ${trackerProviderPredicate('j', provider)} AND w.external_id=?
            AND j.state='FAILED' AND j.attempts>=j.max_attempts LIMIT 1`).get(project, String(workItemId));
        if (exhausted) return null;
      }
      this.upsertProject(project, provider, options.configFile);
      const item = asSqlRow<EventWorkItemRow>(this.db.prepare(`
        INSERT INTO work_items(project_id, external_id, state, created_at, updated_at)
        VALUES (?, ?, 'READY', ?, ?)
        ON CONFLICT(project_id, external_id) DO UPDATE SET updated_at=excluded.updated_at
        RETURNING id, state
      `).get(project, String(workItemId), stamp, stamp));
      if (!item) throw new Error(`Could not persist work item ${project}#${workItemId}`);
      // Only enqueue/claim explicitly READY items. In particular, never turn
      // BLOCKED back into READY here: the lease reaper uses BLOCKED when a job
      // reaches max_attempts, and silently creating a new job would reset that
      // retry budget. Requeueing terminal work requires a separate explicit
      // operation rather than another delivery/claim attempt.
      if (item.state !== 'READY') return null;
      const exhausted = this.db.prepare(`
        SELECT 1 FROM jobs
        WHERE work_item_id=? AND state='FAILED' AND attempts >= max_attempts
        LIMIT 1
      `).get(item.id);
      if (exhausted) return null;
      let job = asSqlRow<IdRow>(
        this.db.prepare("SELECT id FROM jobs WHERE work_item_id=? AND state='READY' ORDER BY id LIMIT 1").get(item.id),
      );
      if (!job) {
        job = asSqlRow<IdRow>(this.db.prepare(`
          INSERT INTO jobs(project_id, work_item_id, provider, state, workflow_state, attempts, max_attempts, created_at, updated_at)
          VALUES (?, ?, ?, 'READY', 'READY', 0, ?, ?, ?) RETURNING id
        `).get(project, item.id, provider, options.maxAttempts ?? 3, stamp, stamp));
        if (!job) throw new Error(`Could not enqueue work item ${project}#${workItemId}`);
        this.recordTransition(Number(job.id), null, 'READY', 'work item queued', options.workerId ?? 'scheduler', stamp);
      }
      const itemClaim = this.db.prepare("UPDATE work_items SET state='CLAIMED', attempts=attempts+1, updated_at=? WHERE id=? AND state='READY' RETURNING id")
        .get(stamp, item.id);
      if (!itemClaim) return null;
      const ownerToken = options.ownerToken ?? randomUUID();
      const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
      const claimed = asSqlRow<ClaimJobRow>(this.db.prepare(`
        UPDATE jobs SET state='CLAIMED', owner_token=?, claimed_by=?, lease_pid=?, lease_start_ticks=?, config_file=?, claimed_at=?, heartbeat_at=?,
          lease_expires_at=?, attempts=attempts+1, updated_at=?
        WHERE id=? AND state='READY' RETURNING id, project_id, work_item_id, provider, owner_token,
          claimed_by, claimed_at, heartbeat_at, lease_expires_at, attempts, max_attempts
      `).get(ownerToken, options.workerId ?? String(process.pid), options.processId === undefined ? process.pid : options.processId,
        options.processId === undefined || options.processId === process.pid ? processStartTicks(process.pid) : null,
        options.configFile ? path.resolve(options.configFile) : null,
        stamp, stamp, new Date(Date.parse(stamp) + leaseMs).toISOString(), stamp, job.id));
      if (!claimed) {
        this.db.prepare("UPDATE work_items SET state='READY' WHERE id=?").run(item.id);
        return null;
      }
      for (const resource of [...new Set(options.resourceLocks ?? [])]) {
        const reserved = this.db.prepare('INSERT OR IGNORE INTO job_resource_locks(resource,job_id,owner_token,lease_expires_at) VALUES (?,?,?,?)')
          .run(resource, claimed.id, ownerToken, claimed.lease_expires_at);
        if (Number(reserved.changes) !== 1) throw new Error(`Resource lock is busy: ${resource}`);
      }
      if (options.configFile) {
        const configPath = path.resolve(options.configFile);
        this.db.prepare('INSERT INTO scheduler_config(config_file,max_concurrency) VALUES (?,?) ON CONFLICT(config_file) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(configPath, globalCap);
        this.db.prepare('INSERT INTO scheduler_project_caps(config_file,project_id,max_concurrency) VALUES (?,?,?) ON CONFLICT(config_file,project_id) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(configPath, project, projectCap);
      }
      this.db.prepare('INSERT INTO scheduler_global_limit(singleton,max_concurrency) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET max_concurrency=excluded.max_concurrency').run(globalCap);
      this.recordTransition(Number(claimed.id), 'READY', 'CLAIMED', 'worker claim', claimed.claimed_by, stamp);
      const workflow = asSqlRow<SqlRow>(this.db.prepare('SELECT workflow_state FROM jobs WHERE id=?').get(claimed.id));
      if (workflow?.workflow_state === 'READY') {
        this.transitionWorkflowInTransaction(Number(claimed.id), 'CLAIMED', 'cli', 'ready work item claimed');
      }
      return claimed;
    });
  }

  heartbeatJob(ownerToken: string, leaseMs = DEFAULT_LEASE_MS) {
    return this.transaction(() => {
      const stamp = nowIso();
      const leaseUntil = new Date(Date.parse(stamp) + leaseMs).toISOString();
      const result = this.db.prepare(`
        UPDATE jobs SET heartbeat_at=?, lease_expires_at=?, updated_at=?
        WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')
      `).run(stamp, leaseUntil, stamp, ownerToken);
      if (Number(result.changes) === 1) this.db.prepare('UPDATE job_resource_locks SET lease_expires_at=? WHERE owner_token=?').run(leaseUntil, ownerToken);
      return Number(result.changes) === 1;
    });
  }

  reapExpiredLeases(now = Date.now()) {
    return this.transaction(() => this.reapExpiredInTransaction(now));
  }

  private reapExpiredInTransaction(now: number) {
    const expired = asSqlRows<ExpiredJobRow>(this.db.prepare(`
      SELECT j.id, j.owner_token, j.work_item_id, j.project_id, j.provider, j.state, j.attempts, j.max_attempts,
        j.claimed_by, j.lease_pid, j.lease_start_ticks
      FROM jobs j WHERE j.state IN ('CLAIMED', 'RUNNING') AND j.lease_expires_at <= ?
    `).all(new Date(now).toISOString()));
    const recovered: Array<{ jobId: number; state: string; workItemId: number }> = [];
    for (const job of expired) {
      const pid = Number(job.lease_pid);
      if (processOwnerAlive(pid, job.lease_start_ticks) !== false) continue;
      const exhausted = Number(job.attempts) >= Number(job.max_attempts);
      const jobState = exhausted ? 'FAILED' : 'READY';
      const itemState = exhausted ? 'BLOCKED' : 'READY';
      const stamp = new Date(now).toISOString();
      if (exhausted) {
        const workflow = asSqlRow<SqlRow>(this.db.prepare('SELECT workflow_state FROM jobs WHERE id=?').get(job.id));
        if (typeof workflow?.workflow_state === 'string' && isWorkflowState(workflow.workflow_state) &&
            !isTerminalWorkflowState(workflow.workflow_state)) {
          this.transitionWorkflowInTransaction(Number(job.id), 'FAILED', 'cli', 'lease expired at max attempts');
        }
      }
      this.db.prepare('UPDATE jobs SET state=?, owner_token=NULL, lease_expires_at=NULL, error_class=?, updated_at=? WHERE id=?')
        .run(jobState, exhausted ? 'LeaseExpiredMaxAttempts' : 'LeaseExpired', stamp, job.id);
      this.db.prepare('UPDATE work_items SET state=?, updated_at=? WHERE id=?').run(itemState, stamp, job.work_item_id);
      this.db.prepare('DELETE FROM job_resource_locks WHERE job_id=? AND owner_token=?').run(job.id, job.owner_token);
      this.db.prepare('UPDATE runtime_state SET active_job_id=NULL, last_run=? WHERE active_job_id=?')
        .run(stamp, job.id);
      this.db.prepare("DELETE FROM scheduler_global_limit WHERE singleton=1 AND NOT EXISTS (SELECT 1 FROM jobs WHERE state IN ('CLAIMED','RUNNING'))").run();
       this.clearProjectCapacityIfIdle(job.project_id, job.provider);
      this.recordTransition(Number(job.id), job.state, jobState, 'lease expired; recovered by reaper', 'lease-reaper', stamp);
      recovered.push({ jobId: Number(job.id), state: jobState, workItemId: Number(job.work_item_id) });
    }
    return recovered;
  }

  counts() {
    const count = (table: string) => Number(asSqlRow<CountRow>(
      this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
    )?.count ?? 0);
    return { events: count('events'), jobs: count('jobs'), transitions: count('job_transitions') };
  }

  rows(sql: string, ...params: SQLInputValue[]): SqlRow[] {
    return this.db.prepare(sql).all(...params);
  }

  operatorCancel(jobId: number) {
    return this.transaction(() => {
      const job = asSqlRow<SqlRow>(this.db.prepare('SELECT state,workflow_state,work_item_id FROM jobs WHERE id=?').get(jobId));
      if (!job) throw new Error(`Job ${jobId} not found`);
      if (job.state !== 'READY') throw new Error(`Job ${jobId} is ${String(job.state)}; only READY queued jobs can be cancelled`);
      if (typeof job.workflow_state !== 'string' || !isWorkflowState(job.workflow_state)) throw new Error(`Job ${jobId} has invalid workflow state; refusing cancellation`);
      const stamp = nowIso();
      this.transitionWorkflowInTransaction(jobId, 'CANCELLED', 'cli', 'cancelled by operator');
      this.db.prepare("UPDATE jobs SET state='CANCELLED',workflow_state='CANCELLED',updated_at=? WHERE id=? AND state='READY'").run(stamp, jobId);
      this.recordTransition(jobId, 'READY', 'CANCELLED', 'cancelled by operator', 'cli', stamp);
      const item = this.db.prepare("UPDATE work_items SET state='CANCELLED',updated_at=? WHERE id=? AND state='READY'").run(stamp, job.work_item_id);
      if (Number(item.changes) !== 1) throw new Error(`Job ${jobId}'s work item is not READY; refusing cancellation`);
    });
  }

  operatorRetry(jobId: number) {
    return this.transaction(() => {
      const job = asSqlRow<SqlRow>(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId));
      if (!job) throw new Error(`Job ${jobId} not found`);
      if (job.state !== 'FAILED') throw new Error(`Job ${jobId} is ${String(job.state)}; only FAILED jobs can be retried`);
      if (job.workflow_state !== 'FAILED') throw new Error(`Job ${jobId} has workflow state ${String(job.workflow_state)}; refusing unsafe retry`);
      if (Number(job.attempts) >= Number(job.max_attempts)) throw new Error(`Job ${jobId} exhausted max_attempts (${job.attempts}/${job.max_attempts})`);
      if (job.branch || job.change_number || job.head_sha || job.evidence_commit) throw new Error(`Job ${jobId} has workflow identifiers; manual recovery required`);
      if (this.db.prepare('SELECT 1 FROM artifacts WHERE job_id=? LIMIT 1').get(jobId) || this.db.prepare('SELECT 1 FROM side_effect_journal WHERE job_id=? LIMIT 1').get(jobId)) throw new Error(`Job ${jobId} has artifact or side-effect history; manual recovery required`);
      if (this.db.prepare("SELECT 1 FROM jobs WHERE state IN ('CLAIMED','RUNNING') LIMIT 1").get()) throw new Error('Queue has an active job; retry after it is released');
      if (this.db.prepare("SELECT 1 FROM jobs WHERE work_item_id=? AND state='READY' LIMIT 1").get(job.work_item_id)) throw new Error('Work item already has a READY job; retry refused');
      const stamp = nowIso();
      const created = asSqlRow<IdRow>(this.db.prepare("INSERT INTO jobs(project_id,work_item_id,provider,state,workflow_state,attempts,max_attempts,created_at,updated_at) VALUES (?,?,?,'READY','READY',?,?,?,?) RETURNING id").get(job.project_id, job.work_item_id, job.provider, job.attempts, job.max_attempts, stamp, stamp));
      if (!created) throw new Error('Could not create retry job');
      this.recordTransition(Number(created.id), null, 'READY', `retry of failed job ${jobId}`, 'cli', stamp);
      this.db.prepare("UPDATE work_items SET state='READY',updated_at=? WHERE id=?").run(stamp, job.work_item_id);
      return Number(created.id);
    });
  }
}

let runtimeStore: SQLiteStore | undefined;
let runtimePath: string | undefined;

export function getRuntimeStore({ importLegacy = true }: { importLegacy?: boolean } = {}) {
  const file = databasePath();
  if (!runtimeStore || runtimePath !== file) {
    runtimeStore?.close();
    runtimeStore = new SQLiteStore(file);
    runtimePath = file;
  }
  if (importLegacy) {
    const home = path.dirname(file);
    runtimeStore.importLegacy(path.join(home, 'lock.json'));
  }
  return runtimeStore;
}

export function importLegacyState(configFile: string) {
  const store = getRuntimeStore();
  const absolute = path.resolve(configFile);
  const base = path.basename(absolute).replace(/\.[^.]+$/, '');
  const stateFile = path.join(path.dirname(absolute), base === 'config' ? 'state.json' : `${base}.state.json`);
  store.importLegacy(path.join(path.dirname(databasePath()), 'lock.json'), stateFile, absolute);
}

export function quarantineCorruptLegacyLock(configFile: string) {
  const store = getRuntimeStore({ importLegacy: false });
  const absolute = path.resolve(configFile);
  const base = path.basename(absolute).replace(/\.[^.]+$/, '');
  const stateFile = path.join(path.dirname(absolute), base === 'config' ? 'state.json' : `${base}.state.json`);
  return store.quarantineCorruptLegacyLock(
    path.join(path.dirname(databasePath()), 'lock.json'),
    stateFile,
    absolute,
  );
}
