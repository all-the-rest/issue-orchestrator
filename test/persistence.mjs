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

function runTicketSlotWorker(db, id) {
  const code = `
    import { SQLiteStore } from ${JSON.stringify(SOURCE)};
    const store = new SQLiteStore(process.env.TEST_DB);
    const claim = store.tryClaimTicketHandoff(process.env.TEST_ID, 'slot-child', { maxConcurrency: 1 });
    console.log(JSON.stringify(claim));
    if (claim.acquired) await new Promise((resolve) => setTimeout(resolve, 5000));
    store.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TEST_DB: db, TEST_ID: id },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let claimed;
    child.stdout.on('data', (part) => {
      out += part;
      const line = out.split(/\r?\n/).find((entry) => entry.trim());
      if (claimed || !line) return;
      claimed = JSON.parse(line);
      resolve({ child, claim: claimed, stderr: () => err });
    });
    child.stderr.on('data', (part) => { err += part; });
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      if (!claimed) reject(new Error(`ticket slot worker exited ${exitCode}: ${err}`));
    });
  });
}

function waitForClose(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', resolve));
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
  assert.equal(store.rows('SELECT version FROM schema_migrations').length, 15);
  assert.ok(columns('jobs').has('lease_pid'), 'jobs should record the OS process that owns its lease');
  assert.ok(columns('jobs').has('lease_start_ticks'), 'jobs should record process identity to detect PID reuse');
  assert.ok(tables.has('job_resource_locks') && tables.has('scheduler_global_limit'));
  for (const column of ['active_lease_until', 'active_heartbeat_at', 'active_namespace']) {
    assert.ok(columns('ticket_handoffs').has(column), `ticket_handoffs should store ${column}`);
  }
  assert.ok(tables.has('ticket_scheduler_global_limit'), 'the global ticket cap must be durable');
  assert.ok(tables.has('ticket_delivery_state'), 'the global ticket delivery cooldown must be durable');
  assert.ok(tables.has('ticket_api_budget'), 'the shared activation API budget must be durable');
  assert.ok(tables.has('ticket_api_budget_fairness'),
    'the durable cross-project budget rotation must be persisted');
  assert.ok(tables.has('ticket_search_budget'),
    'the durable rolling-window search budget must be persisted');
  assert.ok(columns('ticket_activation_state').has('top_page'),
    'activation scan state records the observed newest page');
  store.close();
  store = new SQLiteStore(migrationFile);
  assert.equal(store.rows('SELECT version FROM schema_migrations').length, 15, 'reopening must not reapply migrations');
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
    DROP TABLE ticket_activation_state;
    DROP TABLE ticket_api_budget;
    DROP TABLE ticket_api_budget_fairness;
    DROP TABLE ticket_search_budget;
    DELETE FROM schema_migrations WHERE version IN (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
  `);
  store.close();
  store = new SQLiteStore(upgradeFile);
  assert.equal(store.rows('SELECT workflow_state FROM jobs WHERE id=?', upgradeJob.id)[0].workflow_state, 'EVIDENCE_PUBLISHED');
  assert.equal(store.rows('SELECT MAX(version) AS version FROM schema_migrations')[0].version, 15);
  store.close();
  ok('v1 jobs retain their workflow meaning when the additive migration is applied');

  const futureSchema = path.join(TMP, 'future-schema', 'orchestrator.sqlite3');
  fs.mkdirSync(path.dirname(futureSchema), { recursive: true });
  const futureDb = new DatabaseSync(futureSchema);
  futureDb.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  futureDb.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (16, ?)').run(new Date().toISOString());
  futureDb.close();
  assert.throws(() => new SQLiteStore(futureSchema), /newer than supported version/);
  const stillFutureDb = new DatabaseSync(futureSchema);
  assert.equal(Number(stillFutureDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version), 16);
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

  const aliasAnchor = storeAt('ticket-alias-anchor');
  const aliasHandoff = 'b'.repeat(64);
  const aliasJob = aliasAnchor.ensureTicketAgentJob({
    handoffId: aliasHandoff, project: 'Owner/Repo', issue: 106,
    configFile: path.join(TMP, 'ticket-config.jsonc'),
  });
  const aliasSession = aliasAnchor.createAgentSession({ jobId: aliasJob, externalSessionId: 'alias-ticket-session',
    role: 'ticket-agent', model: 'test/model', worktree: TMP,
    ndjsonPath: path.join(TMP, 'alias-events.ndjson'), stderrPath: path.join(TMP, 'alias-stderr.log') });
  assert.equal(aliasAnchor.ensureTicketAgentJob({ handoffId: aliasHandoff, project: 'owner/repo', issue: 106 }), aliasJob,
    'a project spelling alias must reuse the existing ticket-agent job anchor');
  const resumedAlias = aliasAnchor.getAgentSession(aliasSession.externalSessionId);
  assert.equal(resumedAlias?.jobId, aliasJob, 'the persisted agent session remains resumable by the alias');
  aliasAnchor.close();
  ok('ticket agent sessions have a stable terminal job anchor without occupying queue capacity');

  const ticketWorkflowStore = storeAt('ticket-workflows');
  const routeWorkflowHandoff = ticketWorkflowStore.getOrCreateTicketHandoff({
    id: 'a1'.repeat(32), project: 'owner/repo', issue: 88, goalHash: 'c1'.repeat(32),
    goal: 'Route GitHub ticket owner/repo#88', state: { terminal: false, workflow: 'route-only' },
  });
  assert.throws(() => ticketWorkflowStore.getOrCreateTicketHandoff({
    id: 'b2'.repeat(32), project: 'owner/repo', issue: 88, goalHash: 'd3'.repeat(32),
    goal: 'Legacy goal acceptance criteria', state: { terminal: false, workflow: 'goal' },
  }), /active handoff/, 'goal and route-only handoffs must not coexist on one issue/worktree');
  ticketWorkflowStore.updateTicketHandoff(routeWorkflowHandoff.id, { terminal: true, workflow: 'route-only' });
  const legacyGoalHandoff = ticketWorkflowStore.getOrCreateTicketHandoff({
    id: 'b2'.repeat(32), project: 'owner/repo', issue: 88, goalHash: 'd3'.repeat(32),
    goal: 'Legacy goal acceptance criteria', state: { terminal: false, workflow: 'goal' },
  });
  assert.equal(legacyGoalHandoff.id, 'b2'.repeat(32));
  const listedHandoffs = ticketWorkflowStore.listTicketHandoffs('OWNER/REPO');
  assert.deepEqual(listedHandoffs.map((entry) => entry.issue).sort((a, b) => a - b), [88, 88],
    'closed-issue discovery lists persisted handoffs by case-insensitive project');
  assert.ok(listedHandoffs.every((entry) => typeof entry.updatedAt === 'string' && entry.updatedAt));
  assert.deepEqual(ticketWorkflowStore.listTicketHandoffs('other/repo'), []);
  assert.throws(() => ticketWorkflowStore.listTicketHandoffs('owner/repo', 0), /limit/);

  // Claims also guard the legacy case where two workflow handoffs already exist.
  const stamp = new Date().toISOString();
  const insertHandoff = ticketWorkflowStore.db.prepare(`INSERT INTO ticket_handoffs
    (id,project,issue,goal_hash,goal_json,state_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  insertHandoff.run('e4'.repeat(32), 'owner/repo', 89, 'f5'.repeat(32), JSON.stringify('one'),
    JSON.stringify({ terminal: false, workflow: 'goal' }), stamp, stamp);
  insertHandoff.run('a6'.repeat(32), 'owner/repo', 89, 'b7'.repeat(32), JSON.stringify('two'),
    JSON.stringify({ terminal: false, workflow: 'route-only' }), stamp, stamp);
  assert.equal(ticketWorkflowStore.claimTicketHandoff('e4'.repeat(32), 'owner-one'), true);
  assert.equal(ticketWorkflowStore.claimTicketHandoff('a6'.repeat(32), 'owner-two'), false,
    'a concurrent goal and route-only claim on one issue is rejected');
  ticketWorkflowStore.releaseTicketHandoff('e4'.repeat(32), 'owner-one');
  assert.equal(ticketWorkflowStore.claimTicketHandoff('a6'.repeat(32), 'owner-two'), true,
    'the second workflow can claim once the first owner is released');
  ticketWorkflowStore.releaseTicketHandoff('a6'.repeat(32), 'owner-two');
  ticketWorkflowStore.close();
  ok('goal and route-only ticket handoffs cannot overlap on one issue/worktree');

  // Global ticket-session admission is one transaction shared by every poller.
  const slotStore = storeAt('ticket-session-slots');
  const slotInsert = slotStore.db.prepare(`INSERT INTO ticket_handoffs
    (id,project,issue,goal_hash,goal_json,state_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  const addSlot = (id, issue, state) => slotInsert.run(id, 'owner/repo', issue, `${id.slice(0, 32)}`,
    JSON.stringify(`Route GitHub ticket owner/repo#${issue}`), JSON.stringify(state), stamp, stamp);
  const slotA = 'a1'.repeat(32);
  const slotB = 'b2'.repeat(32);
  const slotC = 'c3'.repeat(32);
  const slotD = 'd4'.repeat(32);
  for (const [id, issue] of [[slotA, 90], [slotB, 91], [slotC, 92], [slotD, 93]]) {
    addSlot(id, issue, { terminal: false, workflow: 'route-only' });
  }
  const slotPeer = storeAt('ticket-session-slots');
  assert.equal(slotStore.tryClaimTicketHandoff(slotA, 'slot-owner-a', { maxConcurrency: 2 }).acquired, true);
  assert.equal(slotPeer.tryClaimTicketHandoff(slotB, 'slot-owner-b', { maxConcurrency: 2 }).acquired, true,
    'concurrent pollers share one durable admission counter');
  assert.deepEqual(slotStore.tryClaimTicketHandoff(slotC, 'slot-owner-c', { maxConcurrency: 2 }),
    { acquired: false, reason: 'CAPACITY', activeCount: 2 },
    'a third issue is deferred without starting another session');
  slotStore.releaseTicketHandoff(slotA, 'slot-owner-a');
  assert.equal(slotStore.tryClaimTicketHandoff(slotC, 'slot-owner-c', { maxConcurrency: 2 }).acquired, true,
    'releasing a live session admits the next issue');

  // A durable pending batch owns its issue across workflow keys even while no
  // worker is executing it. This prevents goal and route-only chats from racing.
  slotStore.releaseTicketHandoff(slotB, 'slot-owner-b');
  slotStore.releaseTicketHandoff(slotC, 'slot-owner-c');
  slotStore.updateTicketHandoff(slotC, {
    terminal: true, workflow: 'route-only', quietUntil: Date.now() + 60_000,
    deferredUpdates: [{ id: '1', author: 'human', body: 'pending', createdAt: '2026-03-01', source: 'ticket' }],
    deferredFields: [],
  });
  const slotSameIssue = 'f6'.repeat(32);
  addSlot(slotSameIssue, 92, { terminal: true, workflow: 'goal' });
  assert.deepEqual(slotStore.tryClaimTicketHandoff(slotSameIssue, 'slot-owner-same', { maxConcurrency: 1 }),
    { acquired: false, reason: 'BUSY' },
    'a pending quiet-period batch blocks another workflow on the same issue');
  slotStore.updateTicketHandoff(slotC, { terminal: true, workflow: 'route-only', quietUntil: null,
    deferredUpdates: [], deferredFields: [] });
  assert.equal(slotStore.tryClaimTicketHandoff(slotSameIssue, 'slot-owner-same', { maxConcurrency: 1 }).acquired, true);
  slotStore.releaseTicketHandoff(slotSameIssue, 'slot-owner-same');
  assert.equal(slotStore.tryClaimTicketHandoff(slotD, 'slot-owner-d', { maxConcurrency: 1 }).acquired, true);
  slotStore.releaseTicketHandoff(slotD, 'slot-owner-d');

  // A worker killed after claiming must not leak a slot forever.
  slotStore.db.prepare('UPDATE ticket_handoffs SET active_owner=?,active_pid=?,active_start_ticks=? WHERE id=?')
    .run('dead-owner', 99_999_999, null, slotA);
  const slotE = 'e5'.repeat(32);
  addSlot(slotE, 94, { terminal: false, workflow: 'route-only' });
  assert.equal(slotStore.tryClaimTicketHandoff(slotE, 'slot-owner-e', { maxConcurrency: 1 }).acquired, true,
    'dead owners are reclaimed so restart recovery can admit new work');
  slotStore.releaseTicketHandoff(slotE, 'slot-owner-e');

  // Real processes: a child poller holds the slot while the parent is refused.
  const slotF = 'f7'.repeat(32);
  addSlot(slotF, 95, { terminal: false, workflow: 'route-only' });
  const worker = await runTicketSlotWorker(path.join(TMP, 'ticket-session-slots', 'orchestrator.sqlite3'), slotE);
  assert.equal(worker.claim.acquired, true);
  assert.deepEqual(slotStore.tryClaimTicketHandoff(slotF, 'slot-owner-parent', { maxConcurrency: 1 }),
    { acquired: false, reason: 'CAPACITY', activeCount: 1 },
    'a live worker in another process occupies the global session slot');
  worker.child.kill('SIGTERM');
  await waitForClose(worker.child);
  assert.equal(slotStore.tryClaimTicketHandoff(slotF, 'slot-owner-parent', { maxConcurrency: 1 }).acquired, true,
    'a crashed or stopped worker no longer occupies the slot');
  slotStore.releaseTicketHandoff(slotF, 'slot-owner-parent');

  // Leases, not PIDs alone, authorize ownership. A look-alike PID in a foreign
  // namespace cannot steal a valid lease, and an expired lease is reclaimable.
  const leaseId = 'aa'.repeat(32);
  addSlot(leaseId, 96, { terminal: false, workflow: 'route-only' });
  assert.equal(slotStore.tryClaimTicketHandoff(leaseId, 'lease-owner', { leaseMs: 60_000 }).acquired, true);
  slotStore.db.prepare('UPDATE ticket_handoffs SET active_namespace=?,active_pid=?,active_lease_until=? WHERE id=?')
    .run('pid:foreign-namespace', process.pid, new Date(Date.now() + 60_000).toISOString(), leaseId);
  assert.deepEqual(slotStore.tryClaimTicketHandoff(leaseId, 'lookalike-owner', { leaseMs: 60_000 }),
    { acquired: false, reason: 'BUSY' },
    'a look-alike PID in another namespace cannot steal a live lease');
  assert.equal(slotStore.heartbeatTicketHandoff(leaseId, 'lease-owner', 60_000), true);
  assert.equal(slotStore.heartbeatTicketHandoff(leaseId, 'wrong-owner', 60_000), false,
    'only the current owner can renew a lease');
  slotStore.db.prepare('UPDATE ticket_handoffs SET active_lease_until=? WHERE id=?')
    .run(new Date(Date.now() - 1_000).toISOString(), leaseId);
  assert.equal(slotStore.tryClaimTicketHandoff(leaseId, 'expired-owner', { leaseMs: 60_000 }).acquired, true,
    'an expired durable lease is reclaimable even when the old PID number is alive');
  assert.throws(() => slotStore.updateTicketHandoff(leaseId, { terminal: true }, 'stale-owner-write'),
    /ownership was lost/, 'owner-CAS prevents a stale worker from overwriting newer state');

  // GitHub project case aliases share one issue/worktree.
  const aliasA = 'a8'.repeat(32);
  const aliasB = 'b9'.repeat(32);
  const aliasInsert = slotStore.db.prepare(`INSERT INTO ticket_handoffs
    (id,project,issue,goal_hash,goal_json,state_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  aliasInsert.run(aliasA, 'Owner/Repo', 97, '18'.repeat(32), JSON.stringify('one'),
    JSON.stringify({ terminal: true, workflow: 'goal' }), stamp, stamp);
  aliasInsert.run(aliasB, 'owner/repo', 97, '29'.repeat(32), JSON.stringify('two'),
    JSON.stringify({ terminal: true, workflow: 'route-only' }), stamp, stamp);
  assert.equal(slotStore.tryClaimTicketHandoff(aliasA, 'alias-owner', { leaseMs: 60_000 }).acquired, true);
  assert.deepEqual(slotStore.tryClaimTicketHandoff(aliasB, 'alias-other', { leaseMs: 60_000 }),
    { acquired: false, reason: 'BUSY' },
    'GitHub project spelling variants cannot run one issue twice');
  slotStore.releaseTicketHandoff(aliasA, 'alias-owner');
  slotStore.close();
  slotPeer.close();

  // Conflicting poller caps are persisted and fail closed while work is active.
  const capStore = storeAt('ticket-cap-mismatch');
  const capInsert = capStore.db.prepare(`INSERT INTO ticket_handoffs
    (id,project,issue,goal_hash,goal_json,state_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  const addCap = (id, issue) => capInsert.run(id, 'owner/repo', issue, `${id.slice(0, 32)}`,
    JSON.stringify(`Route GitHub ticket owner/repo#${issue}`), JSON.stringify({ terminal: false, workflow: 'route-only' }),
    stamp, stamp);
  const capA = 'c1'.repeat(32);
  const capB = 'd2'.repeat(32);
  const capC = 'e3'.repeat(32);
  addCap(capA, 101);
  addCap(capB, 102);
  addCap(capC, 103);
  assert.equal(capStore.tryClaimTicketHandoff(capA, 'cap-owner-a', { maxConcurrency: 1 }).acquired, true);
  assert.deepEqual(capStore.tryClaimTicketHandoff(capB, 'cap-owner-b', { maxConcurrency: 2 }),
    { acquired: false, reason: 'CONFIG_MISMATCH', activeCount: 1 },
    'a poller cannot silently use a different cap while another session is active');
  capStore.releaseTicketHandoff(capA, 'cap-owner-a');
  assert.equal(capStore.tryClaimTicketHandoff(capB, 'cap-owner-b', { maxConcurrency: 2 }).acquired, true,
    'a quiescent database may adopt the newly configured cap');
  assert.deepEqual(capStore.tryClaimTicketHandoff(capC, 'cap-owner-c', { maxConcurrency: 1 }),
    { acquired: false, reason: 'CONFIG_MISMATCH', activeCount: 1 });
  capStore.releaseTicketHandoff(capB, 'cap-owner-b');
  assert.equal(capStore.tryClaimTicketHandoff(capC, 'cap-owner-c', { maxConcurrency: 1 }).acquired, true);
  capStore.releaseTicketHandoff(capC, 'cap-owner-c');

  // Intake observation locks are a separate claim kind and never consume a
  // global session slot, but they still own their issue against dispatch.
  const intakeA = 'a4'.repeat(32);
  const sessionB = 'b5'.repeat(32);
  addCap(intakeA, 104);
  addCap(sessionB, 105);
  assert.equal(capStore.tryClaimTicketHandoff(intakeA, 'intake-owner', { kind: 'intake' }).acquired, true);
  assert.equal(capStore.tryClaimTicketHandoff(sessionB, 'session-owner', { maxConcurrency: 1 }).acquired, true,
    'an intake claim does not consume the global session slot');
  assert.deepEqual(capStore.tryClaimTicketHandoff(intakeA, 'session-other', { maxConcurrency: 1 }),
    { acquired: false, reason: 'BUSY' },
    'an intake lock still protects its issue from a concurrent agent session');
  capStore.releaseTicketHandoff(sessionB, 'session-owner');
  capStore.releaseTicketHandoff(intakeA, 'intake-owner');
  capStore.close();
  ok('ticket session admission is atomic, DB-wide, lease-based, alias-safe and restart-safe');

  // The global delivery cooldown is start-to-start, durable, and enforced in
  // one SQLite transaction so competing pollers cannot both start a turn.
  const deliveryPath = path.join(TMP, 'ticket-delivery', 'orchestrator.sqlite3');
  let deliveryStore = new SQLiteStore(deliveryPath);
  assert.equal(deliveryStore.readTicketDispatchStart(60_000), null);
  assert.deepEqual(deliveryStore.claimTicketDispatchStart({ cooldownMs: 60_000, now: 1_000_000 }),
    { acquired: true, lastStartedAt: 1_000_000, nextAllowedAt: null });
  assert.deepEqual(deliveryStore.claimTicketDispatchStart({ cooldownMs: 60_000, now: 1_059_999 }),
    { acquired: false, lastStartedAt: 1_000_000, nextAllowedAt: 1_060_000 });
  assert.equal(deliveryStore.readTicketDispatchStart(60_000), 1_000_000);
  assert.deepEqual(deliveryStore.claimTicketDispatchStart({ cooldownMs: 60_000, now: 1_060_000 }),
    { acquired: true, lastStartedAt: 1_060_000, nextAllowedAt: null },
    'the cooldown boundary is inclusive for the next start');
  assert.throws(() => deliveryStore.readTicketDispatchStart(30_000), /must be identical/,
    'a poller with a different cooldown fails closed');
  assert.throws(() => deliveryStore.claimTicketDispatchStart({ cooldownMs: 30_000, now: 1_060_001 }),
    /must be identical/);

  // There is no refund path: an ambiguous dispatch failure conservatively
  // keeps the claim, so the next start still waits for the full interval.
  assert.equal(deliveryStore.readTicketDispatchStart(60_000), 1_060_000,
    'a failed launch keeps its cooldown claim');
  assert.deepEqual(deliveryStore.claimTicketDispatchStart({ cooldownMs: 60_000, now: 1_090_000 }),
    { acquired: false, lastStartedAt: 1_060_000, nextAllowedAt: 1_120_000 },
    'another issue cannot start early after a failed launch');

  // Changing the cooldown is an explicit transition: the anchor is preserved,
  // the new value applies to it immediately, and another live ticket lease must
  // be stopped first.
  const reconfigured = deliveryStore.reconfigureTicketDelivery({ cooldownMs: 120_000 });
  assert.deepEqual(reconfigured, {
    changed: true, previousCooldownMs: 60_000, cooldownMs: 120_000, lastStartedAt: 1_060_000,
    nextAllowedAt: 1_180_000,
  }, 'reconfiguration keeps the global last-start anchor and reports the new boundary');
  assert.deepEqual(deliveryStore.claimTicketDispatchStart({ cooldownMs: 120_000, now: 1_100_000 }),
    { acquired: false, lastStartedAt: 1_060_000, nextAllowedAt: 1_180_000 },
    'the longer reconfigured cooldown applies from the existing anchor');
  assert.equal(deliveryStore.claimTicketDispatchStart({ cooldownMs: 120_000, now: 1_180_000 }).acquired, true);
  const lowered = deliveryStore.reconfigureTicketDelivery({ cooldownMs: 30_000 });
  assert.equal(lowered.nextAllowedAt, 1_210_000,
    'lowering the cooldown keeps the anchor but applies the new interval immediately');
  assert.equal(deliveryStore.claimTicketDispatchStart({ cooldownMs: 30_000, now: 1_210_000 }).acquired, true,
    'the lowered boundary is eligible as soon as the new interval has elapsed');
  deliveryStore.close();
  deliveryStore = new SQLiteStore(deliveryPath);
  assert.equal(deliveryStore.readTicketDispatchStart(30_000), 1_210_000,
    'the cooldown anchor survives a restart');
  deliveryStore.close();

  const reconfigurePath = path.join(TMP, 'ticket-delivery-reconfigure', 'orchestrator.sqlite3');
  const reconfigureStore = new SQLiteStore(reconfigurePath);
  reconfigureStore.getOrCreateTicketHandoff({ id: '7a'.repeat(32), project: 'owner/repo', issue: 106,
    goalHash: '8b'.repeat(32), goal: 'Route GitHub ticket owner/repo#106',
    state: { terminal: false, workflow: 'route-only' } });
  assert.equal(reconfigureStore.tryClaimTicketHandoff('7a'.repeat(32), 'reconfigure-owner').acquired, true);
  assert.throws(() => reconfigureStore.reconfigureTicketDelivery({ cooldownMs: 60_000 }),
    /active ticket session and intake claim to stop/,
    'a live ticket lease blocks a cooldown transition');
  reconfigureStore.releaseTicketHandoff('7a'.repeat(32), 'reconfigure-owner');
  const quiescent = reconfigureStore.reconfigureTicketDelivery({ cooldownMs: 60_000 });
  assert.equal(quiescent.changed, true);
  assert.equal(quiescent.lastStartedAt, null);
  reconfigureStore.close();

  const zeroPath = path.join(TMP, 'ticket-delivery-zero', 'orchestrator.sqlite3');
  const zeroStore = new SQLiteStore(zeroPath);
  assert.equal(zeroStore.claimTicketDispatchStart({ cooldownMs: 0, now: 2_000_000 }).acquired, true);
  assert.equal(zeroStore.claimTicketDispatchStart({ cooldownMs: 0, now: 2_000_000 }).acquired, true,
    'cooldown 0 is disabled and admits every turn');
  zeroStore.close();

  const peerPath = path.join(TMP, 'ticket-delivery-peer', 'orchestrator.sqlite3');
  const peerA = new SQLiteStore(peerPath);
  const peerB = new SQLiteStore(peerPath);
  assert.equal(peerA.claimTicketDispatchStart({ cooldownMs: 60_000, now: 3_000_000 }).acquired, true);
  assert.equal(peerB.claimTicketDispatchStart({ cooldownMs: 60_000, now: 3_000_000 }).acquired, false,
    'two pollers sharing the database cannot both start at the same instant');
  peerA.close();
  peerB.close();
  ok('ticket delivery cooldown is durable, transactional across pollers, restart-safe, conservatively consumed on failure, explicitly reconfigurable and config-matched');

  // --- Activation scan state: stale writers cannot regress positives or
  // overwrite a newer revision/cursor. The merge is a compare-and-swap inside
  // one write transaction, interleaved here through two SQLite handles. ---
  const activationPath = path.join(TMP, 'ticket-activation-merge', 'orchestrator.sqlite3');
  const activationA = new SQLiteStore(activationPath);
  const activationB = new SQLiteStore(activationPath);
  const baseState = {
    key: 'owner/repo#7\u0000policy', project: 'owner/repo', issue: 7, policy: 'policy',
    revision: '2026-05-01T00:00:00Z', matched: false, completeRevision: null, nextPage: 9,
    topPage: 10, checkedAt: 1_000, lastCompleteAt: null, failures: 0,
  };
  activationA.writeTicketActivationState(baseState);
  activationA.writeTicketActivationState({ ...baseState, matched: true,
    completeRevision: baseState.revision, nextPage: null, checkedAt: 1_100, lastCompleteAt: 1_100 });
  // A stale writer still believes the issue is unmentioned and has older progress.
  activationB.writeTicketActivationState({ ...baseState, nextPage: 5, checkedAt: 900 });
  let mergedState = activationA.readTicketActivationState(baseState.key);
  assert.equal(mergedState.matched, true, 'a persisted positive is monotonic under a stale negative writer');
  assert.equal(mergedState.completeRevision, baseState.revision);
  assert.equal(mergedState.nextPage, null, 'a stale cursor cannot reopen a completed scan');
  assert.equal(mergedState.checkedAt, 1_100, 'a stale timestamp cannot move the check time backwards');

  const newerRevision = '2026-05-02T00:00:00Z';
  activationA.writeTicketActivationState({ ...baseState, revision: newerRevision, matched: false,
    completeRevision: newerRevision, topPage: 12, nextPage: null, checkedAt: 2_000, lastCompleteAt: 2_000 });
  activationB.writeTicketActivationState({ ...baseState, revision: baseState.revision, nextPage: 7,
    checkedAt: 5_000 });
  mergedState = activationA.readTicketActivationState(baseState.key);
  assert.equal(mergedState.revision, newerRevision,
    'a stale writer cannot overwrite a newer issue revision');
  assert.equal(mergedState.completeRevision, newerRevision);
  assert.equal(mergedState.nextPage, null, 'a stale cursor cannot replace a newer completed range');
  assert.equal(mergedState.checkedAt, 2_000);

  // An older-revision positive observation must still latch admission, but it
  // must not drag the committed row back to the stale revision or replace its
  // cursor. This is the dedicated stale-positive branch.
  const stalePositiveKey = 'owner/repo#10\u0000policy';
  activationA.writeTicketActivationState({ ...baseState, key: stalePositiveKey, issue: 10,
    revision: newerRevision, matched: false, completeRevision: null, nextPage: 5, topPage: 12,
    checkedAt: 6_000 });
  activationB.writeTicketActivationState({ ...baseState, key: stalePositiveKey, issue: 10,
    matched: true, completeRevision: baseState.revision, nextPage: null, topPage: 10,
    checkedAt: 5_500, lastCompleteAt: 5_500 });
  mergedState = activationA.readTicketActivationState(stalePositiveKey);
  assert.equal(mergedState.matched, true,
    'an older-revision positive observation still proves admission and latches');
  assert.equal(mergedState.revision, newerRevision,
    'latching a stale positive keeps the newer observed revision');
  assert.equal(mergedState.completeRevision, null,
    'latching a stale positive does not fabricate a completion for the newer revision');
  assert.equal(mergedState.nextPage, 5,
    'latching a stale positive leaves the newer descending cursor untouched');
  assert.equal(mergedState.topPage, 12);
  assert.equal(mergedState.checkedAt, 6_000);
  // Even a newer-timestamp stale negative cannot clear the latched positive.
  activationB.writeTicketActivationState({ ...baseState, key: stalePositiveKey, issue: 10,
    matched: false, nextPage: 3, checkedAt: 9_000 });
  mergedState = activationA.readTicketActivationState(stalePositiveKey);
  assert.equal(mergedState.matched, true, 'a stale negative never resets a latched positive');
  assert.equal(mergedState.revision, newerRevision);

  const cursorKey = 'owner/repo#8\u0000policy';
  const cursorBase = { ...baseState, key: cursorKey, issue: 8, revision: newerRevision,
    nextPage: 6, topPage: 12, checkedAt: 3_000 };
  activationA.writeTicketActivationState(cursorBase);
  activationB.writeTicketActivationState({ ...cursorBase, nextPage: 4, checkedAt: 3_100 });
  mergedState = activationA.readTicketActivationState(cursorKey);
  assert.equal(mergedState.nextPage, 4, 'same-revision history progress takes the lower page');
  assert.equal(mergedState.checkedAt, 3_100);
  activationA.writeTicketActivationState({ ...cursorBase, nextPage: 8, checkedAt: 2_800 });
  mergedState = activationA.readTicketActivationState(cursorKey);
  assert.equal(mergedState.nextPage, 4, 'a stale writer cannot move the descending cursor backwards');
  assert.equal(mergedState.checkedAt, 3_100);

  const topChangedKey = 'owner/repo#9\u0000policy';
  const topBase = { ...cursorBase, key: topChangedKey, issue: 9 };
  activationA.writeTicketActivationState(topBase);
  activationB.writeTicketActivationState({ ...topBase, topPage: 13, nextPage: 11, checkedAt: 3_200 });
  mergedState = activationA.readTicketActivationState(topChangedKey);
  assert.equal(mergedState.topPage, 13);
  assert.equal(mergedState.nextPage, 11,
    'a changed thread top replaces the cursor instead of merging an invalid range');

  activationB.writeTicketActivationState({ ...topBase, topPage: 13, completeRevision: newerRevision,
    nextPage: null, checkedAt: 3_300, lastCompleteAt: 3_300 });
  activationA.writeTicketActivationState({ ...topBase, topPage: 13, nextPage: 2, checkedAt: 3_200 });
  mergedState = activationA.readTicketActivationState(topChangedKey);
  assert.equal(mergedState.completeRevision, newerRevision, 'completion is monotonic against a stale writer');
  assert.equal(mergedState.nextPage, null, 'a stale incomplete write cannot un-complete a scanned revision');
  // A genuinely newer observation may find more comments above the saved top
  // and legitimately resume an incomplete range for the same revision.
  activationA.writeTicketActivationState({ ...topBase, topPage: 14, nextPage: 13, checkedAt: 3_400 });
  mergedState = activationA.readTicketActivationState(topChangedKey);
  assert.equal(mergedState.completeRevision, null,
    'a newer incomplete observation of a grown thread is not reported as a completed negative');
  assert.equal(mergedState.nextPage, 13);
  assert.equal(mergedState.topPage, 14);
  activationA.close();
  activationB.close();
  ok('activation state writes merge stale concurrent pollers without regressing positives, revisions or cursors');

  // --- One shared, time-based activation API budget across poller processes.
  const budgetPath = path.join(TMP, 'ticket-api-budget', 'orchestrator.sqlite3');
  let budgetA = new SQLiteStore(budgetPath);
  let budgetB = new SQLiteStore(budgetPath);
  const budgetOptions = (now, project = 'owner/alpha') => ({ now, limit: 12, windowMs: 60_000, project });
  assert.deepEqual(budgetA.consumeTicketActivationBudget(5, budgetOptions(10_000)),
    { granted: true, remaining: 7, retryAt: null });
  assert.deepEqual(budgetB.consumeTicketActivationBudget(5, budgetOptions(10_000, 'owner/beta')),
    { granted: true, remaining: 2, retryAt: null },
    'a second poller handle consumes the same shared bucket');
  assert.deepEqual(budgetA.activationBudgetFairOrder(['owner/alpha', 'owner/beta']),
    ['owner/alpha', 'owner/beta'],
    'the project served last rotates behind the project served before it');
  budgetA.close();
  budgetA = new SQLiteStore(budgetPath);
  assert.deepEqual(budgetA.activationBudgetFairOrder(['owner/alpha', 'owner/beta', 'owner/gamma']),
    ['owner/gamma', 'owner/alpha', 'owner/beta'],
    'the fair order is durable across a restart and never-served projects go first');
  const budgetDenied = budgetA.consumeTicketActivationBudget(5, budgetOptions(10_000));
  assert.equal(budgetDenied.granted, false);
  assert.equal(budgetDenied.remaining, 2);
  assert.equal(budgetDenied.retryAt, 25_000, 'denial reports the exact refill time');
  assert.equal(budgetA.consumeTicketActivationBudget(13, budgetOptions(10_000)).granted, false,
    'a reservation larger than the bucket fails closed without consuming');
  budgetA.close();
  budgetA = new SQLiteStore(budgetPath);
  assert.equal(budgetA.consumeTicketActivationBudget(5, budgetOptions(24_999)).granted, false,
    'a restart preserves the refill anchor, and time alone refills the bucket');
  assert.equal(budgetA.consumeTicketActivationBudget(5, budgetOptions(25_000)).granted, true,
    'the refilled bucket admits the bounded reservation at the reported time');
  // Both handles race for the whole window at one instant; only one may win.
  const racers = [
    budgetA.consumeTicketActivationBudget(12, budgetOptions(90_000)),
    budgetB.consumeTicketActivationBudget(12, budgetOptions(90_000)),
  ];
  assert.deepEqual(racers.map((entry) => entry.granted), [true, false],
    'two pollers cannot both spend the same tokens');
  assert.throws(() => budgetA.consumeTicketActivationBudget(0, budgetOptions(90_000)),
    /invalid ticket activation API budget arguments/);
  budgetA.close();
  budgetB.close();

  // --- Separate shared search budget with a provable rolling-minute bound.
  // GitHub allows 30 search requests per minute. A token bucket would admit a
  // capacity burst plus refill inside one minute, so the durable store keeps a
  // rolling log and admits only while the trailing minute stays within 30.
  const searchPath = path.join(TMP, 'ticket-search-budget', 'orchestrator.sqlite3');
  let searchA = new SQLiteStore(searchPath);
  let searchB = new SQLiteStore(searchPath);
  const searchOptions = (now, project = 'owner/alpha') => ({
    now, limit: 30, windowMs: 60_000, project });
  const searchProjects = ['owner/alpha', 'owner/beta', 'owner/gamma', 'owner/delta', 'owner/epsilon'];
  const searchStart = 4_000_000;
  const saturated = searchProjects.map((project) =>
    searchA.consumeTicketSearchBudget(10, searchOptions(searchStart, project)));
  assert.deepEqual(saturated.map((entry) => entry.granted), [true, true, true, false, false],
    'five saturated projects cannot exceed 30 search requests in one minute');
  assert.deepEqual(saturated[3], { granted: false, remaining: 0, retryAt: searchStart + 60_000 },
    'the fourth project is denied with the exact rolling-window retry time');
  assert.deepEqual(saturated[4], saturated[3],
    'the fifth project is denied too; more projects never increase the shared quota');
  assert.equal(searchB.consumeTicketSearchBudget(10, searchOptions(searchStart + 59_999, 'owner/zeta'))
    .granted, false, 'a second poller sees the same saturated rolling minute');
  assert.equal(searchA.consumeTicketSearchBudget(10, searchOptions(searchStart + 60_000, 'owner/delta'))
    .granted, true, 'grants expire exactly one window after their own timestamp');
  assert.equal(searchB.consumeTicketSearchBudget(10, searchOptions(searchStart + 90_000, 'owner/epsilon'))
    .granted, true, 'a partially refilled window admits another bounded search');
  assert.equal(searchA.consumeTicketSearchBudget(10, searchOptions(searchStart + 120_000, 'owner/zeta'))
    .granted, true, 'window expiry is per grant, not a full-bucket reset');
  // At 120_000 the trailing window (60_000, 120_000] holds the 90_000 grant
  // plus the new 120_000 grant: 20 of 30; the 60_000 grant has expired.
  assert.equal(searchA.consumeTicketSearchBudget(10, searchOptions(searchStart + 120_000, 'owner/eta'))
    .granted, true, 'the remaining ten-request slice is still admitted');
  assert.equal(searchA.consumeTicketSearchBudget(1, searchOptions(searchStart + 120_000, 'owner/theta'))
    .granted, false, 'even a one-request search is refused once the rolling minute is full');
  const searchDenied = searchB.consumeTicketSearchBudget(1, searchOptions(searchStart + 120_000, 'owner/theta'));
  assert.equal(searchDenied.retryAt, searchStart + 150_000,
    'the retry time is when enough of the oldest cost leaves the rolling window');
  searchA.close();
  searchA = new SQLiteStore(searchPath);
  assert.equal(searchA.consumeTicketSearchBudget(30, searchOptions(searchStart + 120_000, 'owner/theta'))
    .granted, false, 'a restart keeps the rolling log; an earlier clock cannot reset it');
  assert.equal(searchB.consumeTicketSearchBudget(30, searchOptions(searchStart + 180_000, 'owner/theta'))
    .granted, true, 'the full window refills after one minute without grants');
  // A later search grant rotates its project behind every other served
  // project, and search never spends the issue-read bucket: the budgets are
  // durable and independent.
  assert.equal(searchA.consumeTicketSearchBudget(10, searchOptions(searchStart + 240_000, 'owner/alpha'))
    .granted, true);
  assert.deepEqual(searchA.activationBudgetFairOrder(searchProjects),
    ['owner/beta', 'owner/gamma', 'owner/delta', 'owner/epsilon', 'owner/alpha'],
    'search grants share the durable cross-project rotation');
  assert.equal(searchA.consumeTicketActivationBudget(45, {
    now: searchStart + 240_000, limit: 45, windowMs: 60_000, project: 'owner/alpha' }).granted, true,
  'search reservations do not drain the shared issue-read budget');
  const oversizedSearch = searchA.consumeTicketSearchBudget(31,
    searchOptions(searchStart + 300_000, 'owner/theta'));
  assert.equal(oversizedSearch.granted, false,
    'a reservation larger than the whole search window fails closed');
  assert.equal(oversizedSearch.retryAt, null,
    'an oversized search reservation has no admitting retry time');
  assert.throws(() => searchA.consumeTicketSearchBudget(0, searchOptions(searchStart + 300_000)),
    /invalid ticket search budget arguments/);
  searchA.close();
  searchB.close();

  // Two independent poller processes released at the same instant must not both
  // spend the same tokens.
  const processBudgetPath = path.join(TMP, 'ticket-api-budget-process', 'orchestrator.sqlite3');
  const processStart = Date.now() + 500;
  const runBudgetConsumer = () => {
    const code = `
      import { SQLiteStore } from ${JSON.stringify(SOURCE)};
      const store = new SQLiteStore(process.env.TEST_DB);
      while (Date.now() < Number(process.env.TEST_START)) {}
      console.log(JSON.stringify(store.consumeTicketActivationBudget(12, {
        now: 5_000_000, limit: 12, windowMs: 60_000, project: 'owner/race' })));
      store.close();
    `;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, TEST_DB: processBudgetPath, TEST_START: String(processStart) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (part) => { out += part; });
      child.stderr.on('data', (part) => { err += part; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
    });
  };
  const consumerResults = await Promise.all([runBudgetConsumer(), runBudgetConsumer()]);
  const consumerGrants = consumerResults.map((result) => {
    assert.equal(result.code, 0, result.err);
    return JSON.parse(result.out.trim()).granted;
  });
  assert.deepEqual(consumerGrants.sort(), [false, true],
    'racing poller processes cannot both reserve the same shared tokens');
  ok('the activation API budget is shared, durable, clock-based and transactional across poller processes');

  console.log(`\n${passed} persistence checks passed`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
