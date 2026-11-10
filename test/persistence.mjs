#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStore } from '../dist/core/persistence.js';
import { runJournaledSideEffect, sideEffectKey } from '../dist/core/side-effects.js';
import { isAllowedWorkflowTransition, WORKFLOW_STATES } from '../dist/core/state-machine.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-orchestrator-sqlite-'));
const SOURCE = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/core/persistence.js')).href;
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`PASS ${name}`);
}

function storeAt(name) {
  return new SQLiteStore(path.join(TMP, name, 'orchestrator.sqlite3'));
}

function runWorker(db, issue) {
  const code = `
    import { SQLiteStore } from ${JSON.stringify(SOURCE)};
    const store = new SQLiteStore(process.env.TEST_DB);
    const result = store.claimWorkItem('example/project', ${JSON.stringify(issue)}, { workerId: 'worker-${issue}' });
    console.log(JSON.stringify(result));
    store.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TEST_DB: db },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (part) => { out += part; });
    child.stderr.on('data', (part) => { err += part; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function runResumeWorker(db, configFile) {
  const code = `
    import { SQLiteStore } from ${JSON.stringify(SOURCE)};
    const store = new SQLiteStore(process.env.TEST_DB);
    const lock = store.readResumableLock(process.env.TEST_CONFIG);
    console.log(lock ? 'won' : 'lost');
    if (lock) await new Promise((resolve) => setTimeout(resolve, 2000));
    store.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TEST_DB: db, TEST_CONFIG: configFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (part) => { out += part; });
    child.stderr.on('data', (part) => { err += part; });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, out: out.trim(), err }));
  });
}

function runOpen(db) {
  const code = `
    import { SQLiteStore } from ${JSON.stringify(SOURCE)};
    const store = new SQLiteStore(process.env.TEST_DB);
    console.log(store.rows('PRAGMA journal_mode')[0].journal_mode);
    store.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TEST_DB: db },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (part) => { out += part; });
    child.stderr.on('data', (part) => { err += part; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function runGuardAttempt(db) {
  const code = `
    import { SQLiteStore } from ${JSON.stringify(SOURCE)};
    const store = new SQLiteStore(process.env.TEST_DB);
    store.withMutationGuard(() => console.log('entered'));
    store.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TEST_DB: db },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (part) => { out += part; });
    child.stderr.on('data', (part) => { err += part; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

try {
  const migrationFile = path.join(TMP, 'migration', 'orchestrator.sqlite3');
  let store = new SQLiteStore(migrationFile);
  const tables = new Set(store.rows("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
  for (const table of [
    'projects', 'work_items', 'events', 'jobs', 'job_transitions', 'agent_sessions',
    'checks', 'artifacts', 'agent_servers', 'schema_migrations', 'workflow_transitions', 'side_effect_journal',
  ]) assert.ok(tables.has(table), `migration should create ${table}`);
  const columns = (table) => new Set(store.rows(`PRAGMA table_info(${table})`).map((row) => row.name));
  for (const column of ['claimed_by', 'claimed_at', 'heartbeat_at', 'lease_expires_at', 'attempts', 'max_attempts', 'error_class']) {
    assert.ok(columns('jobs').has(column), `jobs should store ${column}`);
  }
  assert.ok(columns('jobs').has('workflow_state'), 'jobs should store guarded workflow progress');
  for (const column of [
    'session_id', 'external_session_id', 'role', 'model', 'worktree', 'status', 'started_at', 'ended_at',
     'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens',
     'cost_usd', 'result_json', 'ndjson_path', 'stderr_path', 'branch', 'base_sha', 'head_sha',
    'change_number', 'evidence_commit', 'error_class', 'execution_owner', 'execution_lease_until',
    'execution_pid', 'execution_pgid', 'execution_start_ticks', 'execution_token', 'oci_identity', 'runner_name',
  ]) {
    assert.ok(columns('agent_sessions').has(column), `agent_sessions should store ${column}`);
  }
  for (const column of ['from_state', 'to_state', 'reason', 'actor', 'created_at']) {
    assert.ok(columns('job_transitions').has(column), `job_transitions should store ${column}`);
  }
  assert.equal(Number(store.rows('PRAGMA foreign_keys')[0].foreign_keys), 1);
  assert.equal(store.rows('PRAGMA journal_mode')[0].journal_mode, 'wal');
  assert.equal(Number(store.rows('PRAGMA busy_timeout')[0].timeout), 5000);
  assert.equal(store.rows('SELECT version FROM schema_migrations').length, 9);
  assert.ok(columns('jobs').has('lease_pid'), 'jobs should record the OS process that owns its lease');
  assert.ok(columns('jobs').has('lease_start_ticks'), 'jobs should record process identity to detect PID reuse');
  assert.ok(tables.has('job_resource_locks') && tables.has('scheduler_global_limit'));
  store.close();
  store = new SQLiteStore(migrationFile);
  assert.equal(store.rows('SELECT version FROM schema_migrations').length, 9, 'reopening must not reapply migrations');
  store.close();
  ok('empty database receives all schema migrations with WAL/foreign keys, and restart is idempotent');

  const upgradeFile = path.join(TMP, 'v1-upgrade', 'orchestrator.sqlite3');
  store = new SQLiteStore(upgradeFile);
  const upgradeJob = store.claimWorkItem('example/project', 299, { workerId: 'v1-upgrade' });
  store.db.prepare("UPDATE jobs SET stage='evidence-published' WHERE id=?").run(upgradeJob.id);
  store.db.exec(`
    DROP TABLE side_effect_journal;
    DROP TABLE workflow_transitions;
    ALTER TABLE jobs DROP COLUMN workflow_state;
    DROP INDEX agent_sessions_external_id;
    DROP INDEX agent_sessions_job_role;
    ALTER TABLE agent_sessions DROP COLUMN external_session_id;
    ALTER TABLE agent_sessions DROP COLUMN role;
    ALTER TABLE agent_sessions DROP COLUMN model;
    ALTER TABLE agent_sessions DROP COLUMN worktree;
    ALTER TABLE agent_sessions DROP COLUMN status;
    ALTER TABLE agent_sessions DROP COLUMN started_at;
    ALTER TABLE agent_sessions DROP COLUMN ended_at;
    ALTER TABLE agent_sessions DROP COLUMN input_tokens;
    ALTER TABLE agent_sessions DROP COLUMN output_tokens;
    ALTER TABLE agent_sessions DROP COLUMN reasoning_tokens;
    ALTER TABLE agent_sessions DROP COLUMN cache_read_tokens;
    ALTER TABLE agent_sessions DROP COLUMN cache_write_tokens;
    ALTER TABLE agent_sessions DROP COLUMN cost_usd;
    ALTER TABLE agent_sessions DROP COLUMN result_json;
    ALTER TABLE agent_sessions DROP COLUMN ndjson_path;
    ALTER TABLE agent_sessions DROP COLUMN stderr_path;
    DROP INDEX agent_sessions_execution_owner;
    ALTER TABLE agent_sessions DROP COLUMN execution_owner;
    ALTER TABLE agent_sessions DROP COLUMN execution_lease_until;
    ALTER TABLE agent_sessions DROP COLUMN execution_pid;
    ALTER TABLE agent_sessions DROP COLUMN execution_pgid;
    ALTER TABLE agent_sessions DROP COLUMN execution_start_ticks;
    ALTER TABLE agent_sessions DROP COLUMN execution_token;
    ALTER TABLE agent_sessions DROP COLUMN oci_identity;
    ALTER TABLE agent_sessions DROP COLUMN runner_name;
    DROP INDEX jobs_one_active_owner_per_work_item;
    DROP TABLE job_resource_locks;
    DROP TABLE scheduler_config;
    DROP TABLE scheduler_project_caps;
    DROP TABLE scheduler_global_limit;
    DROP TABLE scheduler_project_limit;
    ALTER TABLE jobs DROP COLUMN lease_pid;
    ALTER TABLE jobs DROP COLUMN lease_start_ticks;
    DROP TABLE ticket_handoffs;
    DELETE FROM schema_migrations WHERE version IN (2, 3, 4, 5, 6, 7, 8, 9);
  `);
  store.close();
  store = new SQLiteStore(upgradeFile);
  assert.equal(store.rows('SELECT workflow_state FROM jobs WHERE id=?', upgradeJob.id)[0].workflow_state, 'EVIDENCE_PUBLISHED');
  assert.equal(store.rows('SELECT MAX(version) AS version FROM schema_migrations')[0].version, 9);
  store.close();
  ok('v1 jobs retain their workflow meaning when the additive migration is applied');

  const futureSchema = path.join(TMP, 'future-schema', 'orchestrator.sqlite3');
  fs.mkdirSync(path.dirname(futureSchema), { recursive: true });
  const futureDb = new DatabaseSync(futureSchema);
  futureDb.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  futureDb.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (10, ?)').run(new Date().toISOString());
  futureDb.close();
  assert.throws(() => new SQLiteStore(futureSchema), /newer than supported version/);
  const stillFutureDb = new DatabaseSync(futureSchema);
  assert.equal(Number(stillFutureDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version), 10);
  stillFutureDb.close();
  ok('a database with a newer schema version is rejected without being downgraded');

  const simultaneousInitDb = path.join(TMP, 'simultaneous-init', 'orchestrator.sqlite3');
  const initializers = await Promise.all(Array.from({ length: 4 }, () => runOpen(simultaneousInitDb)));
  for (const result of initializers) {
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out.trim(), 'wal');
  }
  ok('simultaneous fresh-database opens retry WAL pragma contention and all initialize successfully');

  store = storeAt('events');
  const event = {
    project: 'example/project', provider: 'github', deliveryId: 'delivery-1',
    workItemId: 42, kind: 'issue.opened', payload: { title: 'A trusted issue' },
  };
  const first = store.recordEventAndEnqueue(event);
  const redelivery = store.recordEventAndEnqueue(event);
  assert.equal(first.inserted, true);
  assert.equal(redelivery.inserted, false);
  assert.equal(store.counts().events, 1);
  assert.equal(store.counts().jobs, 1);
  assert.equal(redelivery.job.state, 'READY');
  const caseVariant = store.recordEventAndEnqueue({
    project: 'EXAMPLE/PROJECT', provider: 'github+issues', deliveryId: 'delivery-case-variant',
    workItemId: 42, kind: 'issue.updated', payload: { title: 'Updated' },
  });
  assert.equal(caseVariant.inserted, true);
  assert.equal(store.counts().events, 2);
  assert.equal(store.counts().jobs, 2);
  const githubRows = store.rows(`SELECT e.project_id AS event_project,j.project_id AS job_project,
      w.project_id AS item_project,w.id AS work_item_id,j.id AS job_id
    FROM events e JOIN jobs j ON j.event_id=e.id JOIN work_items w ON w.id=j.work_item_id
    WHERE e.delivery_id IN ('delivery-1','delivery-case-variant') ORDER BY e.id`);
  assert.equal(new Set(githubRows.map((row) => row.work_item_id)).size, 1);
  assert.equal(new Set(githubRows.map((row) => row.job_id)).size, 2);
  assert.ok(githubRows.every((row) => row.event_project === 'example/project' &&
    row.job_project === 'example/project' && row.item_project === 'example/project'),
  'case-variant events retain the original GitHub project spelling everywhere');
  const distinctTracker = store.recordEventAndEnqueue({
    project: 'EXAMPLE/PROJECT', provider: 'gitlab', deliveryId: 'gitlab-case-variant',
    workItemId: 42, kind: 'issue.opened', payload: { title: 'GitLab issue' },
  });
  assert.equal(distinctTracker.inserted, true);
  assert.equal(store.counts().jobs, 3, 'a non-GitHub tracker remains a distinct case-sensitive project');
  store.recordEventAndEnqueue({
    project: 'example/project', provider: 'gitlab', deliveryId: 'gitlab-same-spelling',
    workItemId: 44, kind: 'issue.opened', payload: {},
  });
  const githubAfterProviderOverwrite = store.recordEventAndEnqueue({
    project: 'EXAMPLE/PROJECT', provider: 'github', deliveryId: 'github-after-overwrite',
    workItemId: 45, kind: 'issue.opened', payload: {},
  });
  assert.equal(store.rows('SELECT project_id FROM events WHERE id=?', githubAfterProviderOverwrite.eventId)[0].project_id, 'example/project',
    'GitHub alias resolution follows durable GitHub job/event identity despite project.provider being overwritten');
  const ambiguousStamp = new Date().toISOString();
  store.db.prepare(`INSERT INTO projects(id,provider,created_at,updated_at) VALUES (?,?,?,?)`)
    .run('Example/Project', 'github', ambiguousStamp, ambiguousStamp);
  assert.throws(() => store.recordEventAndEnqueue({
    project: 'example/project', provider: 'github', deliveryId: 'ambiguous-case',
    workItemId: 43, kind: 'issue.opened', payload: {},
  }), /Ambiguous GitHub project identity/);
  assert.equal(store.counts().events, 5, 'ambiguous identity must not persist an event');
  store.close();
  ok('event enqueue deduplicates deliveries, canonicalizes GitHub project casing, and rejects ambiguity');

  const concurrentDb = path.join(TMP, 'concurrent', 'orchestrator.sqlite3');
  const concurrent = await Promise.all([
    runWorker(concurrentDb, 100),
    runWorker(concurrentDb, 101),
  ]);
  for (const result of concurrent) assert.equal(result.code, 0, result.err);
  const outcomes = concurrent.map((result) => JSON.parse(result.out));
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(outcomes.filter((result) => result === null).length, 1);
  store = new SQLiteStore(concurrentDb);
  const winnerToken = outcomes.find(Boolean).owner_token;
  assert.equal(store.heartbeatJob(winnerToken, 60_000), true);
  assert.equal(store.heartbeatJob('not-the-owner'), false);
  store.close();
  ok('concurrent process claims admit one worker, with an owner-bound heartbeat');

  const guardDb = path.join(TMP, 'guard', 'orchestrator.sqlite3');
  const holderCode = `
    import { SQLiteStore } from ${JSON.stringify(SOURCE)};
    const store = new SQLiteStore(process.env.TEST_DB);
    store.withMutationGuard(() => {
      console.log('held');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    });
  `;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderCode], {
    env: { ...process.env, TEST_DB: guardDb },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let holderErr = '';
  holder.stderr.on('data', (part) => { holderErr += part; });
  await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.stdout.once('data', resolve);
  });
  const refusedGuard = await runGuardAttempt(guardDb);
  assert.notEqual(refusedGuard.code, 0);
  assert.match(refusedGuard.err, /another queue mutation is in progress/);
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('close', resolve));
  const reclaimedGuard = await runGuardAttempt(guardDb);
  assert.equal(reclaimedGuard.code, 0, `${reclaimedGuard.err} ${holderErr}`);
  ok('SQLite mutation guard serializes CLI side effects and reclaims a SIGKILLed owner');

  const killedDb = path.join(TMP, 'killed', 'orchestrator.sqlite3');
  store = new SQLiteStore(killedDb);
  const childCode = `
    import { SQLiteStore } from ${JSON.stringify(SOURCE)};
    const store = new SQLiteStore(process.env.TEST_DB);
    const job = store.claimWorkItem('example/project', 200, { workerId: 'crash-worker', leaseMs: 100, maxAttempts: 2 });
    console.log(JSON.stringify(job));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
    env: { ...process.env, TEST_DB: killedDb },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  let childError = '';
  child.stdout.on('data', (part) => { childOutput += part; });
  child.stderr.on('data', (part) => { childError += part; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
  });
  const childJob = JSON.parse(childOutput.trim().split('\n')[0]);
  assert.ok(childJob?.owner_token, childError);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));
  const expiredAt = Date.parse(childJob.lease_expires_at) + 1000;
  const recovered = store.reapExpiredLeases(expiredAt);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'READY');
  const retry = store.claimWorkItem('example/project', 200, { workerId: 'recovery-worker' });
  assert.ok(retry, 'expired work should be claimable after process death');
  assert.equal(retry.attempts, 2);
  store.close();
  ok('SIGKILL leaves a durable lease that expires and is recovered for another attempt');

  store = storeAt('attempt-limit');
  const eventJob = store.recordEventAndEnqueue({
    project: 'example/project', provider: 'github', deliveryId: 'max-attempts',
    workItemId: 201, kind: 'issue.opened', payload: { number: 201 },
  });
  store.db.prepare('UPDATE jobs SET max_attempts=1 WHERE event_id=?').run(eventJob.eventId);
  const lastAllowedAttempt = store.claimWorkItem('example/project', 201, { leaseMs: 100, processId: 2147483647 });
  assert.ok(lastAllowedAttempt);
  const exhausted = store.reapExpiredLeases(Date.parse(lastAllowedAttempt.lease_expires_at) + 1000);
  assert.equal(exhausted[0].state, 'FAILED');
  assert.equal(store.rows('SELECT state FROM work_items WHERE external_id=?', '201')[0].state, 'BLOCKED');
  assert.equal(store.rows('SELECT workflow_state FROM jobs')[0].workflow_state, 'FAILED');
  assert.equal(store.claimWorkItem('example/project', 201), null);
  assert.equal(store.counts().jobs, 1, 'an exhausted item must not get a fresh job implicitly');
  assert.equal(store.rows('SELECT state, attempts FROM jobs')[0].state, 'FAILED');
  store.recordEventAndEnqueue({
    project: 'example/project', provider: 'github', deliveryId: 'later-event',
    workItemId: 201, kind: 'issue.updated', payload: { number: 201, title: 'updated' },
  });
  assert.equal(store.claimWorkItem('example/project', 201), null, 'a later event must not implicitly requeue a blocked item');
  assert.equal(store.counts().jobs, 1);
  store.close();
  ok('max-attempt failure stays blocked across retries and later events without an explicit requeue');

  const scheduler = storeAt('scheduler-acceptance');
  const configA = path.join(TMP, 'config-a.jsonc');
  const configB = path.join(TMP, 'config-b.jsonc');
  const projectA = scheduler.claimWorkItem('alpha/project', 1, {
    configFile: configA, maxConcurrency: 2, projectConcurrency: 1, workerId: 'alpha-worker',
  });
  const projectB = scheduler.claimWorkItem('beta/project', 2, {
    configFile: configB, maxConcurrency: 2, projectConcurrency: 1, workerId: 'beta-worker',
  });
  assert.ok(projectA && projectB, 'two projects should occupy the two globally configured slots');
  const parallelRows = scheduler.rows("SELECT j.owner_token,w.id AS work_item_id,j.project_id FROM jobs j JOIN work_items w ON w.id=j.work_item_id WHERE j.state IN ('CLAIMED','RUNNING') ORDER BY j.project_id");
  assert.equal(parallelRows.length, 2);
  assert.notEqual(parallelRows[0].owner_token, parallelRows[1].owner_token);
  assert.notEqual(parallelRows[0].work_item_id, parallelRows[1].work_item_id);
  assert.equal(scheduler.claimWorkItem('alpha/project', 3, {
    configFile: configA, maxConcurrency: 2, projectConcurrency: 1,
  }), null, 'same-project cap must be enforced across its work items');
  assert.equal(scheduler.claimWorkItem('gamma/project', 1, {
    configFile: configB, maxConcurrency: 2, projectConcurrency: 1,
  }), null, 'a full global cap blocks another project');
  assert.throws(() => scheduler.claimWorkItem('gamma/project', 3, {
    configFile: path.join(TMP, 'conflicting.jsonc'), maxConcurrency: 3,
  }), /same max_concurrency/, 'active configs must share one DB-global cap');
  scheduler.clearLock(projectA.owner_token);
  scheduler.clearLock(projectB.owner_token);
  scheduler.close();
  ok('two-project concurrency=2, per-project cap, global cross-config cap and work-item uniqueness are transactional');

  const duplicateScheduler = storeAt('scheduler-cross-config-duplicate');
  const uniqueOwner = duplicateScheduler.claimWorkItem('alpha/project', 1, { configFile: configA, maxConcurrency: 2, projectConcurrency: 2 });
  assert.ok(uniqueOwner);
  assert.equal(duplicateScheduler.claimWorkItem('alpha/project', 1, { configFile: configB, maxConcurrency: 2, projectConcurrency: 2 }), null,
    'the same work item cannot be claimed through another config even when capacity is available');
  duplicateScheduler.clearLock(uniqueOwner.owner_token);
  duplicateScheduler.close();

  const githubCaseStore = storeAt('github-case-identity');
  const githubOwner = githubCaseStore.acquireLock({
    repo: 'Acme/Widget', issue: 12, provider: 'github', owner_token: 'github-case-owner',
    config_file: configA, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, false, undefined, { maxConcurrency: 2, projectConcurrency: 1 });
  assert.equal(githubOwner.repo, 'Acme/Widget', 'claim results preserve the configured project spelling');
  assert.throws(() => githubCaseStore.acquireLock({
    repo: 'ACME/WIDGET', issue: 12, provider: 'github', owner_token: 'github-case-duplicate',
    config_file: configB, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, false, undefined, { maxConcurrency: 2, projectConcurrency: 1 }), /already has an active owner/);
  assert.throws(() => githubCaseStore.acquireLock({
    repo: 'acme/widget', issue: 13, provider: 'github', owner_token: 'github-case-cap',
    config_file: configB, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, false, undefined, { maxConcurrency: 2, projectConcurrency: 1 }), /Project run capacity is full/);
  githubCaseStore.clearLock(githubOwner.owner_token);
  const legacyCaseOwner = githubCaseStore.acquireLock({
    repo: 'MiXeD/Legacy', issue: 44, provider: 'github+gitlab', owner_token: 'legacy-case-owner',
    config_file: configA, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, false, undefined, { maxConcurrency: 2, projectConcurrency: 1 });
  assert.equal(legacyCaseOwner.repo, 'MiXeD/Legacy');
  assert.equal(githubCaseStore.readLockForWorkItem('mixed/legacy', 44)?.repo, 'MiXeD/Legacy',
    'case-insensitive owner lookup must return the persisted configured spelling');
  assert.throws(() => githubCaseStore.acquireLock({
    repo: 'mixed/legacy', issue: 44, provider: 'github+github', owner_token: 'legacy-case-duplicate',
    config_file: configB, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, false, undefined, { maxConcurrency: 2, projectConcurrency: 1 }), /already has an active owner/,
  'the tracker (first provider component) controls GitHub case folding');
  assert.throws(() => githubCaseStore.acquireLock({
    repo: 'MIXED/LEGACY', issue: 45, provider: 'github+github', owner_token: 'legacy-case-cap',
    config_file: configB, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }, false, undefined, { maxConcurrency: 2, projectConcurrency: 1 }), /Project run capacity is full/);
  githubCaseStore.clearLock(legacyCaseOwner.owner_token);
  githubCaseStore.close();
  ok('GitHub tracker lock claims preserve configured spelling and match case-insensitive ownership and caps');

  const trackerCapacity = storeAt('tracker-project-capacity');
  const trackerGithub = trackerCapacity.acquireLock({ repo: 'shared/project', issue: 1, provider: 'github', owner_token: 'tracker-github',
    config_file: configA, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, false, undefined,
  { maxConcurrency: 3, projectConcurrency: 1 });
  const trackerGitlab = trackerCapacity.acquireLock({ repo: 'shared/project', issue: 2, provider: 'gitlab', owner_token: 'tracker-gitlab',
    config_file: configB, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, false, undefined,
  { maxConcurrency: 3, projectConcurrency: 2 });
  assert.ok(trackerGithub && trackerGitlab, 'same project spelling has independent tracker capacity');
  assert.equal(trackerCapacity.activeJobCount(), 2);
  assert.throws(() => trackerCapacity.acquireLock({ repo: 'shared/project', issue: 3, provider: 'github', owner_token: 'tracker-github-full',
    config_file: configB, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, false, undefined,
  { maxConcurrency: 3, projectConcurrency: 1 }), /Project run capacity is full/);
  trackerCapacity.clearLock(trackerGithub.owner_token);
  trackerCapacity.clearLock(trackerGitlab.owner_token);
  trackerCapacity.close();
  ok('same-spelling projects on GitHub and GitLab use independent project capacity');

  const githubCapacityCleanup = storeAt('github-capacity-cleanup');
  const firstCasedClaim = githubCapacityCleanup.acquireLock({ repo: 'Acme/Repo', issue: 1, provider: 'github', owner_token: 'case-cap-one', config_file: configA,
    claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, false, undefined, { maxConcurrency: 2, projectConcurrency: 2 });
  const secondCasedClaim = githubCapacityCleanup.acquireLock({ repo: 'acme/repo', issue: 2, provider: 'github', owner_token: 'case-cap-two', config_file: configB,
    claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, false, undefined, { maxConcurrency: 2, projectConcurrency: 2 });
  githubCapacityCleanup.clearLock(firstCasedClaim.owner_token);
  githubCapacityCleanup.clearLock(secondCasedClaim.owner_token);
  assert.equal(githubCapacityCleanup.rows('SELECT COUNT(*) AS count FROM scheduler_project_limit WHERE lower(project_id)=lower(?)', 'Acme/Repo')[0].count, 0,
    'last release clears stale case-variant project capacity rows');
  const newCapOne = githubCapacityCleanup.claimWorkItem('Acme/Repo', 3, { configFile: configA, maxConcurrency: 3, projectConcurrency: 3 });
  const newCapTwo = githubCapacityCleanup.claimWorkItem('acme/repo', 4, { configFile: configB, maxConcurrency: 3, projectConcurrency: 3 });
  assert.ok(newCapOne && newCapTwo, 'new cap may be adopted consistently after previous owners release');
  githubCapacityCleanup.clearLock(newCapOne.owner_token);
  githubCapacityCleanup.clearLock(newCapTwo.owner_token);
  githubCapacityCleanup.close();

  const githubSameConfigCaps = storeAt('github-same-config-caps');
  const originalSpelling = githubSameConfigCaps.claimWorkItem('Case/Project', 1, { configFile: configA, maxConcurrency: 3, projectConcurrency: 2 });
  assert.ok(originalSpelling);
  githubSameConfigCaps.clearLock(originalSpelling.owner_token);
  const changedSpelling = githubSameConfigCaps.claimWorkItem('case/project', 2, { configFile: configA, maxConcurrency: 3, projectConcurrency: 3 });
  assert.ok(changedSpelling);
  const sameConfigConcurrent = githubSameConfigCaps.claimWorkItem('case/project', 3, { configFile: configA, maxConcurrency: 3, projectConcurrency: 3 });
  assert.ok(sameConfigConcurrent, 'inactive case-variant config cap must not conflict after the project cap changes');
  githubSameConfigCaps.clearLock(changedSpelling.owner_token);
  githubSameConfigCaps.clearLock(sameConfigConcurrent.owner_token);
  githubSameConfigCaps.close();

  const githubWorkerCaseStore = storeAt('github-worker-case-identity');
  const oldCaseWorker = githubWorkerCaseStore.claimWorkItem('Old/Case', 31, {
    provider: 'github+gitlab', configFile: configA, maxConcurrency: 2, projectConcurrency: 1,
  });
  assert.ok(oldCaseWorker, 'seed an existing mixed-case tracker record');
  assert.equal(githubWorkerCaseStore.claimWorkItem('old/case', 31, {
    provider: 'github+github', configFile: configB, maxConcurrency: 2, projectConcurrency: 1,
  }), null, 'worker path must not permit a second active owner under different casing');
  assert.equal(githubWorkerCaseStore.claimWorkItem('OLD/CASE', 32, {
    provider: 'github+github', configFile: configB, maxConcurrency: 2, projectConcurrency: 1,
  }), null, 'worker path must enforce project caps across mixed-case identities');
  githubWorkerCaseStore.clearLock(oldCaseWorker.owner_token);
  githubWorkerCaseStore.close();
  ok('GitHub worker claims fail closed across legacy mixed-case active rows, retry history and project limits');

  const legacyHistoryStore = storeAt('github-case-history');
  const priorCase = legacyHistoryStore.claimWorkItem('History/Case', 71, { configFile: configA, maxConcurrency: 2, projectConcurrency: 2 });
  assert.ok(priorCase);
  legacyHistoryStore.clearLock(priorCase.owner_token);
  assert.throws(() => legacyHistoryStore.acquireLock({ repo: 'history/case', issue: 71, provider: 'github', owner_token: 'history-case-new', config_file: configB,
    claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, false, undefined, { maxConcurrency: 2, projectConcurrency: 2 }), /existing history under a different project spelling/,
    'CLI claim must fail closed rather than create a differently cased work item and reset existing retry/workflow history');
  assert.equal(legacyHistoryStore.rows('SELECT COUNT(*) AS count FROM work_items WHERE lower(project_id)=lower(?) AND external_id=?', 'History/Case', '71')[0].count, 1);
  const otherTrackerHistory = legacyHistoryStore.claimWorkItem('history/case', 71, {
    provider: 'gitlab', configFile: configB, maxConcurrency: 2, projectConcurrency: 2,
  });
  assert.ok(otherTrackerHistory, 'same textual project and issue on a different tracker is a distinct work item');
  legacyHistoryStore.clearLock(otherTrackerHistory.owner_token);
  legacyHistoryStore.close();

  const conflictingProjectScheduler = storeAt('scheduler-project-config-conflict');
  const configuredOwner = conflictingProjectScheduler.claimWorkItem('alpha/project', 1, { configFile: configA, maxConcurrency: 2, projectConcurrency: 2 });
  conflictingProjectScheduler.db.prepare('UPDATE scheduler_project_caps SET max_concurrency=1 WHERE config_file=? AND project_id=?').run(configA, 'alpha/project');
  assert.throws(() => conflictingProjectScheduler.claimWorkItem('alpha/project', 2, { configFile: configB, maxConcurrency: 2, projectConcurrency: 2 }), /same project concurrency cap/);
  conflictingProjectScheduler.clearLock(configuredOwner.owner_token);
  conflictingProjectScheduler.close();

  const defaultScheduler = storeAt('scheduler-default-one');
  const defaultA = defaultScheduler.claimWorkItem('one/project', 1, { configFile: configA });
  assert.ok(defaultA);
  assert.equal(defaultScheduler.claimWorkItem('two/project', 2, { configFile: configB }), null,
    'the default global limit remains one');
  defaultScheduler.clearLock(defaultA.owner_token);
  defaultScheduler.close();
  ok('default max_concurrency remains one across configs');

  const resourceScheduler = storeAt('scheduler-resource');
  const browserA = resourceScheduler.claimWorkItem('browser/a', 1, {
    configFile: configA, maxConcurrency: 2, resourceLocks: ['browser'], leaseMs: 100, processId: 2147483647,
  });
  assert.ok(browserA);
  assert.throws(() => resourceScheduler.claimWorkItem('browser/b', 2, {
    configFile: configB, maxConcurrency: 2, resourceLocks: ['browser'],
  }), /Resource lock is busy/);
  resourceScheduler.clearLock(browserA.owner_token);
  const browserB = resourceScheduler.claimWorkItem('browser/b', 2, {
    configFile: configB, maxConcurrency: 2, resourceLocks: ['browser'],
  });
  assert.ok(browserB, 'release must make the named resource available');
  resourceScheduler.clearLock(browserB.owner_token);
  const staleBrowser = resourceScheduler.claimWorkItem('browser/c', 3, {
    configFile: configA, maxConcurrency: 2, resourceLocks: ['browser'], leaseMs: 100, processId: 2147483647,
  });
  const liveJob = resourceScheduler.claimWorkItem('browser/d', 4, {
    configFile: configB, maxConcurrency: 2, leaseMs: 100, processId: process.pid, resourceLocks: ['build'],
  });
  assert.ok(staleBrowser && liveJob);
  const staleBrowserJobId = resourceScheduler.jobIdForOwner(staleBrowser.owner_token);
  const reaped = resourceScheduler.reapExpiredLeases(Date.parse(staleBrowser.lease_expires_at) + 1000);
  assert.deepEqual(reaped.map((entry) => entry.jobId), [staleBrowserJobId]);
  assert.equal(resourceScheduler.readLockByOwner(liveJob.owner_token)?.owner_token, liveJob.owner_token,
    'an expired timestamp must not reap a live process lease');
  assert.throws(() => resourceScheduler.claimWorkItem('browser/f', 6, {
    configFile: configA, maxConcurrency: 2, resourceLocks: ['build'],
  }), /Resource lock is busy/, 'a competing claim must not steal a live expired resource lease');
  const browserAfterReap = resourceScheduler.claimWorkItem('browser/e', 5, {
    configFile: configA, maxConcurrency: 2, resourceLocks: ['browser'],
  });
  assert.ok(browserAfterReap, 'reaping an expired owner releases its named resource');
  resourceScheduler.clearLock(liveJob.owner_token);
  resourceScheduler.clearLock(browserAfterReap.owner_token);
  resourceScheduler.close();
  ok('browser lock serializes then frees on release/reap; stale lease reaps while a live expired lease survives');

  const resumeDb = path.join(TMP, 'atomic-resume', 'orchestrator.sqlite3');
  const resumeConfig = path.join(TMP, 'atomic-resume', 'config.jsonc');
  const resumeStore = new SQLiteStore(resumeDb);
  const staleOwner = resumeStore.claimWorkItem('resume/project', 30, {
    configFile: resumeConfig, leaseMs: 100, processId: 2147483647,
  });
  assert.ok(staleOwner);
  const resumeWorkers = await Promise.all([
    runResumeWorker(resumeDb, resumeConfig), runResumeWorker(resumeDb, resumeConfig),
  ]);
  assert.ok(resumeWorkers.every((worker) => worker.exitCode === 0), JSON.stringify(resumeWorkers));
  assert.deepEqual(resumeWorkers.map((worker) => worker.out).sort(), ['lost', 'won']);
  assert.equal(resumeStore.readResumableLock(resumeConfig)?.owner_token, staleOwner.owner_token,
    'after the winning resumed owner exits, a later restart may atomically take ownership again');
  resumeStore.clearLock(staleOwner.owner_token);
  resumeStore.close();
  ok('stale job resumption atomically binds the lease to one live process and refuses a concurrent resumer');

  const autoResumeStore = storeAt('automatic-resume-resources');
  const autoStale = autoResumeStore.claimWorkItem('resume/stale', 31, {
    configFile: resumeConfig, maxConcurrency: 2, projectConcurrency: 2, processId: 2147483647,
  });
  const browserHolder = autoResumeStore.claimWorkItem('resume/browser', 32, {
    configFile: resumeConfig, maxConcurrency: 2, projectConcurrency: 2, resourceLocks: ['browser'], processId: process.pid,
  });
  assert.ok(autoStale && browserHolder);
  const resumeProjectLimits = {
    'resume/stale': { maxConcurrency: 2, projectConcurrency: 2, resourceLocks: ['browser'] },
    'resume/browser': { maxConcurrency: 2, projectConcurrency: 2, resourceLocks: ['browser'] },
  };
  assert.equal(autoResumeStore.readResumableLock(resumeConfig, resumeProjectLimits), null,
    'busy stale candidate must be skipped without changing its owner');
  assert.equal(autoResumeStore.readLockByOwner(autoStale.owner_token)?.owner_token, autoStale.owner_token);
  autoResumeStore.clearLock(browserHolder.owner_token);
  assert.equal(autoResumeStore.readResumableLock(resumeConfig, resumeProjectLimits)?.owner_token, autoStale.owner_token,
    'after browser release the stale job resumes with the newly required resource reserved');
  assert.equal(autoResumeStore.rows('SELECT resource FROM job_resource_locks WHERE job_id=?', autoStale.id)[0].resource, 'browser');
  autoResumeStore.clearLock(autoStale.owner_token);
  autoResumeStore.close();
  ok('automatic stale resume respects newly configured resources and preserves ownership while busy');

  const legacyResumeStore = storeAt('legacy-resume-capacity');
  const legacyResumeOwner = legacyResumeStore.claimWorkItem('legacy/resume', 90, {
    configFile: configA, maxConcurrency: 2, projectConcurrency: 2, processId: 2147483647,
  });
  const busyResourceOwner = legacyResumeStore.claimWorkItem('legacy/other', 91, {
    configFile: configB, maxConcurrency: 2, projectConcurrency: 2, resourceLocks: ['gpu'], processId: 2147483647,
  });
  assert.ok(legacyResumeOwner && busyResourceOwner);
  const legacyResumeLock = legacyResumeStore.readLockByOwner(legacyResumeOwner.owner_token);
  assert.throws(() => legacyResumeStore.resumeLock(legacyResumeOwner.owner_token, { ...legacyResumeLock, owner_token: 'legacy-resume-busy', config_file: configA, resumed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { maxConcurrency: 2, projectConcurrency: 2, resourceLocks: ['gpu'] }), /Resource lock is busy/);
  assert.equal(legacyResumeStore.readLockByOwner(legacyResumeOwner.owner_token)?.owner_token, legacyResumeOwner.owner_token,
    'failed resume must not change ownership');
  assert.throws(() => legacyResumeStore.resumeLock(legacyResumeOwner.owner_token, { ...legacyResumeLock, owner_token: 'legacy-resume-cap', config_file: configA, resumed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { maxConcurrency: 3, projectConcurrency: 3, resourceLocks: [] }), /same max_concurrency/);
  legacyResumeStore.clearLock(busyResourceOwner.owner_token);
  // Simulate an active legacy row whose scheduler/resource reservations were never recorded.
  legacyResumeStore.db.prepare('DELETE FROM job_resource_locks WHERE job_id=?').run(legacyResumeStore.jobIdForOwner(legacyResumeOwner.owner_token));
  legacyResumeStore.db.prepare('DELETE FROM scheduler_config WHERE config_file=?').run(configA);
  const resumedLegacy = { ...legacyResumeLock, owner_token: 'legacy-resume-won', config_file: configA, resumed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  legacyResumeStore.resumeLock(legacyResumeOwner.owner_token, resumedLegacy, { maxConcurrency: 2, projectConcurrency: 2, resourceLocks: ['gpu'] });
  assert.equal(legacyResumeStore.rows('SELECT owner_token FROM job_resource_locks WHERE resource=?', 'gpu')[0].owner_token, resumedLegacy.owner_token);
  assert.equal(Number(legacyResumeStore.rows('SELECT max_concurrency FROM scheduler_global_limit')[0].max_concurrency), 2);
  legacyResumeStore.clearLock(resumedLegacy.owner_token);
  legacyResumeStore.close();
  ok('legacy explicit resume atomically reserves capacity/resources and refuses busy resources or conflicting caps');

  const workflowDb = path.join(TMP, 'workflow', 'orchestrator.sqlite3');
  let workflowStore = new SQLiteStore(workflowDb);
  const workflowJob = workflowStore.claimWorkItem('example/project', 250, { workerId: 'workflow-test' });
  assert.ok(workflowJob);
  const owner = workflowJob.owner_token;
  const actors = ['cli', 'agent', 'human'];
  for (const from of WORKFLOW_STATES) {
    workflowStore.db.prepare('UPDATE jobs SET workflow_state=? WHERE owner_token=?').run(from, owner);
    for (const to of WORKFLOW_STATES) {
      for (const actor of actors) {
        if (isAllowedWorkflowTransition(from, to, actor)) continue;
        assert.throws(
          () => workflowStore.transitionWorkflow(owner, to, actor, 'invalid matrix edge'),
          /Invalid workflow transition/,
          `${actor} must not transition ${from} -> ${to}`,
        );
      }
    }
  }
  const validEdges = [
    ['NEW', 'TRIAGED', 'agent'],
    ['TRIAGED', 'READY', 'agent'],
    ['READY', 'CLAIMED', 'cli'],
    ['CLAIMED', 'TRIAGED', 'agent'],
    ['TRIAGED', 'ISOLATED', 'agent'],
    ['ISOLATED', 'BEFORE_CAPTURED', 'agent'],
    ['BEFORE_CAPTURED', 'IMPLEMENTING', 'agent'],
    ['IMPLEMENTING', 'IMPLEMENTED', 'agent'],
  ];
  workflowStore.db.prepare("UPDATE jobs SET workflow_state='NEW' WHERE owner_token=?").run(owner);
  for (const [from, to, actor] of validEdges) {
    assert.equal(workflowStore.workflowStateForOwner(owner), from);
    assert.equal(workflowStore.transitionWorkflow(owner, to, actor, 'table-driven valid edge'), true);
    workflowStore.close();
    workflowStore = new SQLiteStore(workflowDb);
    assert.equal(workflowStore.workflowStateForOwner(owner), to, 'workflow state survives restart after every transition');
  }
  workflowStore.db.prepare("UPDATE jobs SET workflow_state='CLAIMED' WHERE owner_token=?").run(owner);
  assert.throws(
    () => workflowStore.transitionWorkflow(owner, 'ISOLATED', 'agent', 'skip triage'),
    /Invalid workflow transition/,
    'isolation must not skip the triaged state',
  );
  workflowStore.db.prepare("UPDATE jobs SET workflow_state='IMPLEMENTED' WHERE owner_token=?").run(owner);
  assert.throws(() => workflowStore.transitionWorkflow(owner, 'CHANGE_OPEN', 'cli', 'missing PR metadata'), /requires a persisted change number/);
  workflowStore.transitionWorkflow(owner, 'BLOCKED', 'cli', 'terminal outcome');
  assert.throws(() => workflowStore.transitionWorkflow(owner, 'NEEDS_INFO', 'human', 'second outcome'), /Invalid workflow transition/);
  assert.equal(workflowStore.workflowStateForOwner(owner), 'BLOCKED', 'terminal outcomes cannot be overwritten');
  workflowStore.close();
  ok('table-driven guarded transitions reject every invalid state/actor edge and persist each valid step across restarts');

  const journalDb = path.join(TMP, 'journal-crash', 'orchestrator.sqlite3');
  let journalStore = new SQLiteStore(journalDb);
  const journalJob = journalStore.claimWorkItem('example/project', 251, { workerId: 'journal-test' });
  const journalOwner = journalJob.owner_token;
  const identity = { target: 'issue#251', body_hash: 'sha256:fixture' };
  const commentKey = sideEffectKey(journalStore, journalOwner, 'comment', identity);
  const commentIntent = { ...identity, marker: commentKey };
  journalStore.beginSideEffect({
    ownerToken: journalOwner, idempotencyKey: commentKey, kind: 'comment', intent: commentIntent,
  });
  journalStore.close(); // crash after durable intent, before external write
  let externalComment = false;
  let commentWrites = 0;
  journalStore = new SQLiteStore(journalDb);
  const firstResume = runJournaledSideEffect({
    store: journalStore,
    ownerToken: journalOwner,
    idempotencyKey: commentKey,
    kind: 'comment',
    intent: commentIntent,
    reconcile: () => externalComment
      ? { state: 'applied', result: { marker: commentKey } }
      : { state: 'absent' },
    apply: () => { commentWrites++; externalComment = true; return { created: true }; },
  });
  assert.equal(firstResume.reconciled, false);
  assert.equal(commentWrites, 1);
  assert.equal(journalStore.sideEffectsForJob(Number(journalJob.id))[0].status, 'COMPLETED');
  journalStore.close();
  journalStore = new SQLiteStore(journalDb);
  const repeatedResume = runJournaledSideEffect({
    store: journalStore,
    ownerToken: journalOwner,
    idempotencyKey: commentKey,
    kind: 'comment',
    intent: commentIntent,
    reconcile: () => externalComment
      ? { state: 'applied', result: { marker: commentKey } }
      : { state: 'absent' },
    apply: () => { commentWrites++; externalComment = true; return { created: true }; },
  });
  assert.equal(repeatedResume.reconciled, true);
  assert.equal(commentWrites, 1, 'a reconciled comment is never written twice');

  const changeIdentity = { head: 'fix/251', base: 'main' };
  const changeKey = sideEffectKey(journalStore, journalOwner, 'change-create', changeIdentity);
  journalStore.beginSideEffect({
    ownerToken: journalOwner,
    idempotencyKey: changeKey,
    kind: 'change-create',
    intent: changeIdentity,
  });
  let externalChangeExists = true; // crash after PR creation, before result journaling
  journalStore.close();
  journalStore = new SQLiteStore(journalDb);
  let duplicateChangeCreates = 0;
  const recoveredChange = runJournaledSideEffect({
    store: journalStore,
    ownerToken: journalOwner,
    idempotencyKey: changeKey,
    kind: 'change-create',
    intent: changeIdentity,
    reconcile: () => externalChangeExists
      ? { state: 'applied', result: { number: 19, head: 'fix/251' } }
      : { state: 'absent' },
    apply: () => { duplicateChangeCreates++; externalChangeExists = true; },
  });
  assert.equal(recoveredChange.reconciled, true);
  assert.equal(duplicateChangeCreates, 0, 'existing external change request is adopted rather than recreated');

  const unknownKey = sideEffectKey(journalStore, journalOwner, 'evidence', { head: 'unknown' });
  assert.throws(() => runJournaledSideEffect({
    store: journalStore,
    ownerToken: journalOwner,
    idempotencyKey: unknownKey,
    kind: 'evidence',
    intent: { head: 'unknown' },
    reconcile: () => ({ state: 'unknown', reason: 'remote unavailable' }),
    apply: () => { throw new Error('must not write'); },
  }), /Cannot safely reconcile/);
  assert.equal(journalStore.sideEffectsForJob(Number(journalJob.id)).find((effect) => effect.idempotencyKey === unknownKey).status, 'UNCERTAIN');
  assert.throws(() => journalStore.beginSideEffect({
    ownerToken: journalOwner, idempotencyKey: commentKey, kind: 'comment', intent: { different: true },
  }), /idempotency key collision/);
  journalStore.close();
  ok('crash-injected side-effect intents reconcile comments and change requests without duplicate writes and fail closed on unknown state');

  const mergeRecoveryStore = storeAt('merge-recovery-capacity');
  const recoveryConfig = path.join(TMP, 'merge-recovery-config.json');
  const mergeJob = mergeRecoveryStore.claimWorkItem('alpha/project', 42, { configFile: recoveryConfig, maxConcurrency: 2, projectConcurrency: 2 });
  const mergeIntent = { project: 'alpha/project', number: 17, head_sha: 'a'.repeat(40), issue: 42, branch: 'fix/42', base: 'main', owner_token: mergeJob.owner_token };
  mergeRecoveryStore.db.prepare("UPDATE jobs SET workflow_state='MERGING', branch=?, head_sha=?, change_number=? WHERE id=?")
    .run(mergeIntent.branch, mergeIntent.head_sha, mergeIntent.number, mergeJob.id);
  mergeRecoveryStore.beginSideEffect({ ownerToken: mergeJob.owner_token, idempotencyKey: 'merge-recovery-test', kind: 'merge', intent: mergeIntent });
  mergeRecoveryStore.db.prepare("UPDATE jobs SET state='READY', owner_token=NULL WHERE id=?").run(mergeJob.id);
  const browserOwner = mergeRecoveryStore.claimWorkItem('beta/project', 1, { configFile: recoveryConfig, maxConcurrency: 2, projectConcurrency: 2, resourceLocks: ['browser'] });
  const recoveryLimits = { maxConcurrency: 2, projectConcurrency: 2, resourceLocks: ['browser'] };
  assert.equal(mergeRecoveryStore.prepareMergedSideEffectRecovery('merge-recovery-test', mergeIntent, recoveryLimits), null, 'busy browser must block merge recovery');
  mergeRecoveryStore.clearLock(browserOwner.owner_token);
  const otherCaseOwner = mergeRecoveryStore.claimWorkItem('ALPHA/project', 43, { configFile: recoveryConfig, maxConcurrency: 2, projectConcurrency: 1 });
  assert.ok(otherCaseOwner);
  assert.equal(mergeRecoveryStore.prepareMergedSideEffectRecovery('merge-recovery-test', mergeIntent, { ...recoveryLimits, projectConcurrency: 1 }), null,
    'merge recovery must count differently cased GitHub project owners against the same cap');
  mergeRecoveryStore.clearLock(otherCaseOwner.owner_token);
  const recoveredMerge = mergeRecoveryStore.prepareMergedSideEffectRecovery('merge-recovery-test', mergeIntent, recoveryLimits);
  assert.ok(recoveredMerge);
  assert.equal(mergeRecoveryStore.rows('SELECT owner_token FROM job_resource_locks WHERE resource=?', 'browser')[0].owner_token, recoveredMerge.owner_token);
  mergeRecoveryStore.clearLock(recoveredMerge.owner_token);

  const activeMergeJob = mergeRecoveryStore.claimWorkItem('gamma/project', 44, {
    configFile: recoveryConfig, maxConcurrency: 2, projectConcurrency: 2, processId: 2147483647,
  });
  assert.ok(activeMergeJob);
  const activeMergeIntent = {
    project: 'gamma/project', number: 18, head_sha: 'b'.repeat(40), issue: 44,
    branch: 'fix/44', base: 'main', owner_token: activeMergeJob.owner_token,
  };
  mergeRecoveryStore.db.prepare("UPDATE jobs SET workflow_state='MERGING', branch=?, head_sha=?, change_number=? WHERE id=?")
    .run(activeMergeIntent.branch, activeMergeIntent.head_sha, activeMergeIntent.number, activeMergeJob.id);
  mergeRecoveryStore.beginSideEffect({ ownerToken: activeMergeJob.owner_token, idempotencyKey: 'active-merge-recovery-test', kind: 'merge', intent: activeMergeIntent });
  const activeBlocker = mergeRecoveryStore.claimWorkItem('delta/project', 1, {
    configFile: recoveryConfig, maxConcurrency: 2, projectConcurrency: 2, resourceLocks: ['gpu'],
  });
  assert.ok(activeBlocker);
  const priorActiveJob = mergeRecoveryStore.rows('SELECT stage, claimed_by, lease_pid, lease_start_ticks, lease_expires_at FROM jobs WHERE id=?', activeMergeJob.id)[0];
  const priorTransitions = mergeRecoveryStore.rows('SELECT COUNT(*) AS count FROM workflow_transitions WHERE job_id=?', activeMergeJob.id)[0].count;
  const activeRecoveryLimits = { maxConcurrency: 2, projectConcurrency: 2, resourceLocks: ['gpu'] };
  assert.equal(mergeRecoveryStore.prepareMergedSideEffectRecovery('active-merge-recovery-test', activeMergeIntent, activeRecoveryLimits), null,
    'a conflicting resource must block recovery for an active dead-owner job');
  assert.deepEqual(mergeRecoveryStore.rows('SELECT stage, claimed_by, lease_pid, lease_start_ticks, lease_expires_at FROM jobs WHERE id=?', activeMergeJob.id)[0], priorActiveJob,
    'resource conflict must not refresh or mutate the dead-owner job');
  assert.equal(mergeRecoveryStore.rows('SELECT COUNT(*) AS count FROM workflow_transitions WHERE job_id=?', activeMergeJob.id)[0].count, priorTransitions);
  assert.equal(mergeRecoveryStore.rows('SELECT status FROM side_effect_journal WHERE idempotency_key=?', 'active-merge-recovery-test')[0].status, 'INTENT');
  assert.equal(Number(mergeRecoveryStore.rows("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('CLAIMED','RUNNING')")[0].count), 2,
    'failed recovery must preserve active capacity accounting');
  mergeRecoveryStore.clearLock(activeBlocker.owner_token);
  const acquiredActiveMerge = mergeRecoveryStore.prepareMergedSideEffectRecovery('active-merge-recovery-test', activeMergeIntent, activeRecoveryLimits);
  assert.ok(acquiredActiveMerge, 'recovery should acquire the resource once it becomes free');
  assert.equal(mergeRecoveryStore.rows('SELECT owner_token FROM job_resource_locks WHERE resource=?', 'gpu')[0].owner_token, activeMergeJob.owner_token);
  assert.equal(mergeRecoveryStore.readLockByOwner(activeMergeJob.owner_token)?.owner_token, activeMergeJob.owner_token);
  assert.equal(Number(mergeRecoveryStore.rows("SELECT COUNT(*) AS count FROM jobs WHERE state IN ('CLAIMED','RUNNING')")[0].count), 1,
    'successful in-place recovery must retain, not double-count, the active capacity slot');
  mergeRecoveryStore.close();
  ok('merged side-effect recovery atomically reserves resources for queued and active dead-owner jobs');

  const legacyHome = path.join(TMP, 'legacy');
  const legacyDb = path.join(legacyHome, 'orchestrator.sqlite3');
  const configFile = path.join(legacyHome, 'config.jsonc');
  const lockFile = path.join(legacyHome, 'lock.json');
  const stateFile = path.join(legacyHome, 'state.json');
  fs.mkdirSync(legacyHome, { recursive: true });
  const legacyLock = {
    provider: 'github', repo: 'example/project', issue: 300, branch: 'fix/legacy',
    account: 'operator', config_file: configFile, owner_token: 'legacy-owner-token',
    stage: 'implemented', claimed_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z', local_only: true,
  };
  fs.writeFileSync(lockFile, JSON.stringify(legacyLock));
  fs.writeFileSync(stateFile, JSON.stringify({ active: legacyLock, last_run: legacyLock.updated_at }));
  store = new SQLiteStore(legacyDb);
  store.importLegacy(lockFile, stateFile, configFile);
  assert.equal(store.readLock().owner_token, legacyLock.owner_token);
  assert.equal(store.readState(configFile).active.issue, 300);
  assert.equal(store.counts().jobs, 1);
  store.importLegacy(lockFile, stateFile, configFile);
  assert.equal(store.counts().jobs, 1, 'legacy import marker must make reruns idempotent');
  assert.equal(store.readResumableLock(configFile), null, 'unknown legacy owner must not be resumed automatically');
  assert.equal(store.reapExpiredLeases().length, 0, 'unknown legacy owner must not be reaped automatically');
  const importedLegacyResume = { ...legacyLock, owner_token: 'confirmed-legacy-owner', resumed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  store.resumeLock(legacyLock.owner_token, importedLegacyResume);
  assert.equal(store.readLock().owner_token, importedLegacyResume.owner_token, 'explicit stale confirmation allows manual legacy recovery');
  store.close();
  ok('legacy state.json/lock.json are imported once into the job and ownership tables');

  const ticketAnchor = storeAt('ticket-agent-anchor');
  const handoffId = 'a'.repeat(64);
  const anchorJobId = ticketAnchor.ensureTicketAgentJob({
    handoffId, project: 'owner/repo', issue: 71, configFile: path.join(TMP, 'ticket-config.jsonc'),
  });
  assert.equal(ticketAnchor.ensureTicketAgentJob({ handoffId, project: 'owner/repo', issue: 71 }), anchorJobId,
    'recovery must reuse the same runner job anchor');
  assert.equal(Number(ticketAnchor.rows("SELECT COUNT(*) AS count FROM jobs WHERE stage='ticket-handoff'")[0].count), 1);
  const anchorSession = ticketAnchor.createAgentSession({ jobId: anchorJobId, externalSessionId: 'ticket-session-71',
    role: 'builder', model: 'test/model', worktree: TMP, ndjsonPath: path.join(TMP, 'ticket-events.ndjson'),
    stderrPath: path.join(TMP, 'ticket-stderr.log') });
  assert.equal(anchorSession.jobId, anchorJobId);
  assert.equal(ticketAnchor.rows('SELECT state,workflow_state FROM jobs WHERE id=?', anchorJobId)[0].state, 'DONE');
  ticketAnchor.close();
  ok('ticket agent sessions have a stable terminal job anchor without occupying queue capacity');

  console.log(`\n${passed} persistence checks passed`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
