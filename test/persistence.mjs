#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStore } from '../dist/core/persistence.js';

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
    'checks', 'artifacts', 'agent_servers', 'schema_migrations',
  ]) assert.ok(tables.has(table), `migration should create ${table}`);
  const columns = (table) => new Set(store.rows(`PRAGMA table_info(${table})`).map((row) => row.name));
  for (const column of ['claimed_by', 'claimed_at', 'heartbeat_at', 'lease_expires_at', 'attempts', 'max_attempts', 'error_class']) {
    assert.ok(columns('jobs').has(column), `jobs should store ${column}`);
  }
  for (const column of ['session_id', 'branch', 'base_sha', 'head_sha', 'change_number', 'evidence_commit', 'error_class']) {
    assert.ok(columns('agent_sessions').has(column), `agent_sessions should store ${column}`);
  }
  for (const column of ['from_state', 'to_state', 'reason', 'actor', 'created_at']) {
    assert.ok(columns('job_transitions').has(column), `job_transitions should store ${column}`);
  }
  assert.equal(Number(store.rows('PRAGMA foreign_keys')[0].foreign_keys), 1);
  assert.equal(store.rows('PRAGMA journal_mode')[0].journal_mode, 'wal');
  assert.equal(Number(store.rows('PRAGMA busy_timeout')[0].timeout), 5000);
  assert.equal(store.rows('SELECT version FROM schema_migrations').length, 1);
  store.close();
  store = new SQLiteStore(migrationFile);
  assert.equal(store.rows('SELECT version FROM schema_migrations').length, 1, 'reopening must not reapply migrations');
  store.close();
  ok('empty database receives all schema migrations with WAL/foreign keys, and restart is idempotent');

  const futureSchema = path.join(TMP, 'future-schema', 'orchestrator.sqlite3');
  fs.mkdirSync(path.dirname(futureSchema), { recursive: true });
  const futureDb = new DatabaseSync(futureSchema);
  futureDb.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  futureDb.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)').run(new Date().toISOString());
  futureDb.close();
  assert.throws(() => new SQLiteStore(futureSchema), /newer than supported version/);
  const stillFutureDb = new DatabaseSync(futureSchema);
  assert.equal(Number(stillFutureDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version), 2);
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
