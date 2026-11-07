import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

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

interface ActiveIdRow extends IdRow {
  owner_token: string;
}

interface LegacyJobRow extends IdRow {
  external_id?: string;
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
  state: string;
  config_file: string | null;
}

interface EventWorkItemRow extends IdRow {
  state: string;
}

interface EventIdRow extends IdRow {}

interface EventJobRow extends IdRow {}

interface WorkItemRow extends IdRow {
  state: string;
}

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
}

interface CountRow extends SqlRow {
  count: number | bigint;
}

interface EventStateRow extends SqlRow {
  id: number | bigint;
  state: string;
}

interface JobStateRow extends IdRow {
  state: string;
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
];

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
    try {
      return fn();
    } finally {
      this.transaction(() => this.db.prepare('DELETE FROM mutation_guards WHERE id=1 AND owner_token=?').run(ownerToken));
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
        throw new Error(`Legacy ${isLockFile ? 'lock' : 'state'} is corrupt: ${absolute} (${(error as Error).message})`);
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
      INSERT INTO jobs(project_id, work_item_id, owner_token, config_file, provider, state, stage, branch,
        account, local_only, claimed_by, claimed_at, heartbeat_at, lease_expires_at, attempts,
        change_number, head_sha, evidence_commit, release_result, resumed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'CLAIMED', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      lock.repo, item.id, lock.owner_token, lock.config_file ?? null, lock.provider ?? 'github',
      lock.stage ?? 'claimed', lock.branch ?? null, lock.account ?? null, lock.local_only ? 1 : 0,
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

  readLock(): Lock | null {
    const row = asSqlRow<LockRow>(this.db.prepare(`
      SELECT j.*, w.external_id, j.project_id
      FROM jobs j JOIN work_items w ON w.id=j.work_item_id
      WHERE j.state IN ('CLAIMED', 'RUNNING') LIMIT 1
    `).get());
    return fromRow(row);
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

  writeState(state: RuntimeStateInput, configFile: string) {
    const absolute = path.resolve(configFile);
    const job = state.active?.owner_token
      ? asSqlRow<IdRow>(this.db.prepare('SELECT id FROM jobs WHERE owner_token=?').get(state.active.owner_token))
      : null;
    this.db.prepare(`
      INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)
      ON CONFLICT(config_file) DO UPDATE SET active_job_id=excluded.active_job_id, last_run=excluded.last_run
    `).run(absolute, job?.id ?? null, state.last_run ?? null);
  }

  acquireLock(lock: Lock, force = false, expectedOwnerToken?: string) {
    let retryExhausted = false;
    const claimed = this.transaction(() => {
      this.reapExpiredInTransaction(Date.now());
      const exhausted = this.db.prepare(`
        SELECT j.id FROM jobs j JOIN work_items w ON w.id=j.work_item_id
        WHERE j.project_id=? AND w.external_id=? AND j.state='FAILED' AND j.attempts >= j.max_attempts
        LIMIT 1
      `).get(lock.repo, String(lock.issue));
      if (exhausted) {
        retryExhausted = true;
        return null;
      }

      const current = this.readLock();
      if (current && !force) {
        throw new Error(
          `Queue is locked by ${current.repo}#${current.issue} since ${current.claimed_at}; ` +
          'release --force only for a stale run',
        );
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
          INSERT INTO jobs(project_id, work_item_id, provider, state, attempts, created_at, updated_at)
          VALUES (?, ?, ?, 'READY', 0, ?, ?) RETURNING id
        `).get(lock.repo, item.id, lock.provider, lock.claimed_at, lock.updated_at));
        if (!queued) throw new Error(`Could not queue work item ${lock.repo}#${lock.issue}`);
        this.recordTransition(Number(queued.id), null, 'READY', 'work item queued for CLI claim', lock.owner_token, lock.claimed_at);
      }
      const leaseMs = Number(lock.lease_ms ?? DEFAULT_LEASE_MS);
      const updated = asSqlRow<IdRow>(this.db.prepare(`
        UPDATE jobs SET owner_token=?, config_file=?, provider=?, state='CLAIMED', stage=?, branch=?, account=?,
          local_only=?, claimed_by=?, claimed_at=?, heartbeat_at=?, lease_expires_at=?, attempts=attempts+1,
          change_number=?, head_sha=?, evidence_commit=?, updated_at=?
        WHERE id=? AND state='READY' RETURNING id
      `).get(
        lock.owner_token, path.resolve(lock.config_file), lock.provider, lock.stage ?? 'claimed', lock.branch ?? null,
        lock.account ?? null, lock.local_only ? 1 : 0, String(process.pid), lock.claimed_at, lock.updated_at,
        new Date(Date.parse(lock.updated_at) + leaseMs).toISOString(), lock.change_number ?? null,
        lock.head_sha ?? null, lock.evidence_commit ?? null, lock.updated_at, queued.id,
      ));
      if (!updated) throw new Error(`Job for ${lock.repo}#${lock.issue} is not ready to claim`);
      this.recordTransition(Number(updated.id), 'READY', 'CLAIMED', 'claimed from CLI', lock.owner_token, lock.claimed_at);
      this.db.prepare(`
        INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)
        ON CONFLICT(config_file) DO UPDATE SET active_job_id=excluded.active_job_id, last_run=excluded.last_run
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
      this.db.prepare(`
        UPDATE jobs SET config_file=?, stage=?, branch=?, account=?, local_only=?, change_number=?, head_sha=?,
          evidence_commit=?, release_result=?, resumed_at=?, heartbeat_at=?,
          lease_expires_at=?, updated_at=? WHERE id=?
      `).run(
        path.resolve(lock.config_file), lock.stage ?? null, lock.branch ?? null, lock.account ?? null,
        lock.local_only ? 1 : 0, lock.change_number ?? null, lock.head_sha ?? null, lock.evidence_commit ?? null,
        lock.release_result ?? null, lock.resumed_at ?? null, nowIso(),
        new Date(Date.now() + DEFAULT_LEASE_MS).toISOString(), lock.updated_at ?? nowIso(), before.id,
      );
      if (before.stage !== lock.stage) {
        this.recordTransition(Number(before.id), before.state, before.state,
          `workflow checkpoint: ${before.stage ?? '(unset)'} -> ${lock.stage ?? '(unset)'}`,
          lock.owner_token, lock.updated_at ?? nowIso());
      }
      this.db.prepare(`
        INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)
        ON CONFLICT(config_file) DO UPDATE SET active_job_id=excluded.active_job_id, last_run=excluded.last_run
      `).run(path.resolve(lock.config_file), before.id, lock.updated_at ?? nowIso());
      return lock;
    });
  }

  resumeLock(previousToken: string, lock: Lock) {
    return this.transaction(() => {
      const before = asSqlRow<IdRow>(
        this.db.prepare("SELECT id FROM jobs WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')").get(previousToken),
      );
      if (!before) throw new Error('Queue lock ownership changed; refusing to resume another run');
      this.db.prepare(`
        UPDATE jobs SET owner_token=?, config_file=?, account=?, resumed_at=?, heartbeat_at=?, lease_expires_at=?, updated_at=?
        WHERE id=?
      `).run(lock.owner_token, path.resolve(lock.config_file), lock.account ?? null, lock.resumed_at,
        nowIso(), new Date(Date.now() + DEFAULT_LEASE_MS).toISOString(), lock.updated_at, before.id);
      this.recordTransition(Number(before.id), 'CLAIMED', 'CLAIMED', 'ownership resumed', lock.owner_token, lock.updated_at);
      this.db.prepare(`
        INSERT INTO runtime_state(config_file, active_job_id, last_run) VALUES (?, ?, ?)
        ON CONFLICT(config_file) DO UPDATE SET active_job_id=excluded.active_job_id, last_run=excluded.last_run
      `).run(path.resolve(lock.config_file), before.id, lock.updated_at);
      return lock;
    });
  }

  clearLock(ownerToken?: string, result = 'none') {
    return this.transaction(() => {
      const current = this.readLock();
      if (!current) {
        if (ownerToken) throw new Error('Queue lock ownership changed; refusing to clear another run\'s lock');
        return false;
      }
      if (ownerToken && current.owner_token !== ownerToken) {
        throw new Error('Queue lock ownership changed; refusing to clear another run\'s lock');
      }
      const state = result === 'done' ? 'DONE' : result === 'blocked' ? 'BLOCKED' : result === 'review' ? 'REVIEW' :
        result === 'needs-info' ? 'NEEDS_INFO' : 'READY';
      this.finishActiveJob(current.owner_token, 'RELEASED', `released: ${result}`, state);
      return true;
    });
  }

  private finishActiveJob(ownerToken: string, finalState: string, reason: string, itemState = 'READY') {
    const row = asSqlRow<FinishingJobRow>(
      this.db.prepare("SELECT id, work_item_id, state, config_file FROM jobs WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')")
        .get(ownerToken),
    );
    if (!row) return false;
    const stamp = nowIso();
    this.db.prepare("UPDATE jobs SET state=?, lease_expires_at=NULL, updated_at=? WHERE id=? AND state IN ('CLAIMED', 'RUNNING')")
      .run(finalState, stamp, row.id);
    this.db.prepare('UPDATE work_items SET state=?, updated_at=? WHERE id=?').run(itemState, stamp, row.work_item_id);
    this.recordTransition(Number(row.id), row.state, finalState, reason, ownerToken, stamp);
    if (row.config_file) {
      this.db.prepare('UPDATE runtime_state SET active_job_id=NULL, last_run=? WHERE config_file=? AND active_job_id=?')
        .run(stamp, row.config_file, row.id);
    }
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
      const dedupeKey = event.deliveryId
        ? `${event.provider}:delivery:${event.deliveryId}`
        : `${event.project}:${event.workItemId}:${event.kind}:${payloadHash}`;
      this.upsertProject(event.project, event.provider);
      const item = asSqlRow<EventWorkItemRow>(this.db.prepare(`
        INSERT INTO work_items(project_id, external_id, title, author, url, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'READY', ?, ?)
        ON CONFLICT(project_id, external_id) DO UPDATE SET
          title=COALESCE(excluded.title, work_items.title), author=COALESCE(excluded.author, work_items.author),
          url=COALESCE(excluded.url, work_items.url), updated_at=excluded.updated_at
        RETURNING id, state
      `).get(event.project, String(event.workItemId), event.title ?? null, event.author ?? null, event.url ?? null, stamp, stamp));
      if (!item) throw new Error(`Could not persist event work item ${event.project}#${event.workItemId}`);
      const payloadJson = JSON.stringify(event.payload);
      if (payloadJson === undefined) throw new Error('event payload must be JSON serializable');
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO events(project_id, work_item_id, provider, delivery_id, dedupe_key, kind,
          payload_hash, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(event.project, item.id, event.provider, event.deliveryId ?? null, dedupeKey, event.kind,
        payloadHash, payloadJson, stamp);
      const eventRow = asSqlRow<EventIdRow>(
        this.db.prepare('SELECT id FROM events WHERE dedupe_key=? OR (provider=? AND delivery_id=?) LIMIT 1')
          .get(dedupeKey, event.provider, event.deliveryId ?? null),
      );
      if (!eventRow) throw new Error('Could not read the persisted event');
      if (Number(inserted.changes) > 0 && item.state === 'READY') {
        const queued = asSqlRow<EventIdRow>(this.db.prepare(`
          INSERT OR IGNORE INTO jobs(project_id, work_item_id, event_id, provider, state, attempts, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'READY', 0, ?, ?) RETURNING id
        `).get(event.project, item.id, eventRow.id, event.provider, stamp, stamp));
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
  } = {}) {
    return this.transaction(() => {
      this.reapExpiredInTransaction(Date.now());
      if (this.readLock()) return null;
      const provider = options.provider ?? 'github';
      const stamp = nowIso();
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
          INSERT INTO jobs(project_id, work_item_id, provider, state, attempts, max_attempts, created_at, updated_at)
          VALUES (?, ?, ?, 'READY', 0, ?, ?, ?) RETURNING id
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
        UPDATE jobs SET state='CLAIMED', owner_token=?, claimed_by=?, claimed_at=?, heartbeat_at=?,
          lease_expires_at=?, attempts=attempts+1, updated_at=?
        WHERE id=? AND state='READY' RETURNING id, project_id, work_item_id, provider, owner_token,
          claimed_by, claimed_at, heartbeat_at, lease_expires_at, attempts, max_attempts
      `).get(ownerToken, options.workerId ?? String(process.pid), stamp, stamp,
        new Date(Date.parse(stamp) + leaseMs).toISOString(), stamp, job.id));
      if (!claimed) {
        this.db.prepare("UPDATE work_items SET state='READY' WHERE id=?").run(item.id);
        return null;
      }
      this.recordTransition(Number(claimed.id), 'READY', 'CLAIMED', 'worker claim', claimed.claimed_by, stamp);
      return claimed;
    });
  }

  heartbeatJob(ownerToken: string, leaseMs = DEFAULT_LEASE_MS) {
    const stamp = nowIso();
    const result = this.db.prepare(`
      UPDATE jobs SET heartbeat_at=?, lease_expires_at=?, updated_at=?
      WHERE owner_token=? AND state IN ('CLAIMED', 'RUNNING')
    `).run(stamp, new Date(Date.parse(stamp) + leaseMs).toISOString(), stamp, ownerToken);
    return Number(result.changes) === 1;
  }

  reapExpiredLeases(now = Date.now()) {
    return this.transaction(() => this.reapExpiredInTransaction(now));
  }

  private reapExpiredInTransaction(now: number) {
    const expired = asSqlRows<ExpiredJobRow>(this.db.prepare(`
      SELECT j.id, j.owner_token, j.work_item_id, j.state, j.attempts, j.max_attempts
      FROM jobs j WHERE j.state IN ('CLAIMED', 'RUNNING') AND j.lease_expires_at <= ?
    `).all(new Date(now).toISOString()));
    const recovered: Array<{ jobId: number; state: string; workItemId: number }> = [];
    for (const job of expired) {
      const exhausted = Number(job.attempts) >= Number(job.max_attempts);
      const jobState = exhausted ? 'FAILED' : 'READY';
      const itemState = exhausted ? 'BLOCKED' : 'READY';
      const stamp = new Date(now).toISOString();
      this.db.prepare('UPDATE jobs SET state=?, owner_token=NULL, lease_expires_at=NULL, error_class=?, updated_at=? WHERE id=?')
        .run(jobState, exhausted ? 'LeaseExpiredMaxAttempts' : 'LeaseExpired', stamp, job.id);
      this.db.prepare('UPDATE work_items SET state=?, updated_at=? WHERE id=?').run(itemState, stamp, job.work_item_id);
      this.db.prepare('UPDATE runtime_state SET active_job_id=NULL, last_run=? WHERE active_job_id=?')
        .run(stamp, job.id);
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
