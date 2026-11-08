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
    'execution_pid', 'execution_pgid', 'execution_start_ticks', 'execution_token',
  ]) {
    assert.ok(columns('agent_sessions').has(column), `agent_sessions should store ${column}`);
  }
  for (const column of ['from_state', 'to_state', 'reason', 'actor', 'created_at']) {
    assert.ok(columns('job_transitions').has(column), `job_transitions should store ${column}`);
  }
  assert.equal(Number(store.rows('PRAGMA foreign_keys')[0].foreign_keys), 1);
  assert.equal(store.rows('PRAGMA journal_mode')[0].journal_mode, 'wal');
  assert.equal(Number(store.rows('PRAGMA busy_timeout')[0].timeout), 5000);
  assert.equal(store.rows('SELECT version FROM schema_migrations').length, 4);
  store.close();
  store = new SQLiteStore(migrationFile);
  assert.equal(store.rows('SELECT version FROM schema_migrations').length, 4, 'reopening must not reapply migrations');
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
    DELETE FROM schema_migrations WHERE version IN (2, 3, 4);
  `);
  store.close();
  store = new SQLiteStore(upgradeFile);
  assert.equal(store.rows('SELECT workflow_state FROM jobs WHERE id=?', upgradeJob.id)[0].workflow_state, 'EVIDENCE_PUBLISHED');
  assert.equal(store.rows('SELECT MAX(version) AS version FROM schema_migrations')[0].version, 4);
  store.close();
  ok('v1 jobs retain their workflow meaning when the additive migration is applied');

  const futureSchema = path.join(TMP, 'future-schema', 'orchestrator.sqlite3');
  fs.mkdirSync(path.dirname(futureSchema), { recursive: true });
  const futureDb = new DatabaseSync(futureSchema);
  futureDb.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  futureDb.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?)').run(new Date().toISOString());
  futureDb.close();
  assert.throws(() => new SQLiteStore(futureSchema), /newer than supported version/);
  const stillFutureDb = new DatabaseSync(futureSchema);
  assert.equal(Number(stillFutureDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version), 5);
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
  store.close();
  ok('provider redelivery deduplicates to one event row and one queued job');

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
  const lastAllowedAttempt = store.claimWorkItem('example/project', 201, { leaseMs: 100 });
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
  store.close();
  ok('legacy state.json/lock.json are imported once into the job and ownership tables');

  console.log(`\n${passed} persistence checks passed`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
