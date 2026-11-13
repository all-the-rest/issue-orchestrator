import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SQLiteStore } from '../dist/core/persistence.js';
import { loadConfig, repoConfig } from '../dist/core/config.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-cli-'));
const bin = path.join(root, 'bin');
const home = path.join(root, 'runtime');
const config = path.join(root, 'config.jsonc');
const openCodeConfig = path.join(root, 'opencode.jsonc');
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
fs.mkdirSync(bin, { recursive: true });

const dod = {
  commands: { build: null, test: null, lint: null, typecheck: null, security: null },
  required_checks: ['CI'], evidence_class: 'cli', acceptance_source: 'issue_body',
};
fs.writeFileSync(config, JSON.stringify({
  model: 'openai/test-model', agent_runner: 'opencode', accounts: ['configured-account'],
  repos: { 'owner/repo': { account: 'configured-account', dod } },
}));
assert.equal(loadConfig(config).agent_runner, 'opencode');
assert.equal(repoConfig(loadConfig(config), 'owner/repo').agent_runner, 'opencode');
fs.writeFileSync(config, JSON.stringify({
  model: 'openai/test-model', agent_runner: 'opencode', accounts: ['configured-account'],
  repos: { 'owner/repo': { account: 'configured-account', tickets: { activation_mention: 'reisi007-jr' }, dod } },
}));
assert.equal(repoConfig(loadConfig(config), 'owner/repo').tickets.activation_mention, 'reisi007-jr',
  'per-repository activation mention is retained in the resolved settings');
for (const login of ['@reisi007-jr', 'bad login', '-invalid', 'invalid-', 'two--hyphens', 'x'.repeat(40)]) {
  fs.writeFileSync(config, JSON.stringify({
    model: 'openai/test-model', agent_runner: 'opencode', accounts: ['configured-account'],
    repos: { 'owner/repo': { account: 'configured-account', tickets: { activation_mention: login }, dod } },
  }));
  assert.throws(() => loadConfig(config), /activation_mention.*GitHub login/,
    `invalid activation login ${login} is rejected`);
}
fs.writeFileSync(config, JSON.stringify({
  model: 'openai/test-model', agent_runner: 'opencode', accounts: ['configured-account'],
  tickets: { activation_mention: 'reisi007-jr' },
  repos: { 'owner/repo': { account: 'configured-account', dod } },
}));
assert.throws(() => loadConfig(config), /activation_mention.*only valid per repository/,
  'activation mention is accepted only under a repository ticket setting');
fs.writeFileSync(config, JSON.stringify({
  model: 'openai/test-model', agent_runner: 'unknown', accounts: ['configured-account'],
  repos: { 'owner/repo': { account: 'configured-account', dod } },
}));
assert.throws(() => loadConfig(config), /unsupported agent_runner/);
fs.writeFileSync(config, JSON.stringify({
  model: 'openai/test-model', agent_runner: 'opencode', accounts: ['configured-account'],
  repos: { 'owner/repo': { account: 'configured-account', dod } },
}));
fs.writeFileSync(openCodeConfig, JSON.stringify({ agents: { general: { model: 'openai/test-model' } } }));

function executable(name, contents) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, contents, { mode: 0o755 });
}
function env(extra = {}) {
  return {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    ISSUE_ORCHESTRATOR_CONFIG: config,
    ISSUE_ORCHESTRATOR_HOME: home,
    OPENCODE_CONFIG: openCodeConfig,
    ...extra,
  };
}
function run(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { env: env(extraEnv), encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
function storeForOperator(runtimeHome) {
  return new SQLiteStore(path.join(runtimeHome, 'orchestrator.sqlite3'));
}

try {
  executable('gh', '#!/bin/sh\nif [ "$1 $2" = "auth status" ]; then echo "Logged in to github.com account ${FAKE_GH_ACCOUNT:-configured-account} (keyring)" >&2; exit 0; fi\nexit 2\n');
  executable('opencode', '#!/bin/sh\necho "OpenCode 2.2.6"\n');

  const healthy = run(['doctor', '--json']);
  assert.equal(healthy.code, 0, healthy.stderr);
  const report = JSON.parse(healthy.stdout);
  assert.equal(report.schema_version, 1);
  assert.deepEqual(report.checks.map(({ name }) => name), ['gh', 'opencode', 'git', 'model', 'disk', 'sqlite']);
  assert(report.checks.every(({ name, status }) => typeof name === 'string' && status === 'ok'));
  assert(report.checks.every(({ message }) => typeof message === 'string'));
  assert.doesNotMatch(healthy.stdout, /token|password|secret/i);

  const mismatch = run(['doctor', '--json'], { FAKE_GH_ACCOUNT: 'wrong-account' });
  assert.equal(mismatch.code, 1);
  assert.match(JSON.parse(mismatch.stdout).checks.find(({ name }) => name === 'gh').message, /does not match configured accounts/);

  fs.renameSync(path.join(bin, 'gh'), path.join(bin, 'gh.disabled'));
  fs.renameSync(path.join(bin, 'opencode'), path.join(bin, 'opencode.disabled'));
  const missing = run(['doctor', '--json'], { PATH: bin });
  assert.equal(missing.code, 1);
  const missingChecks = JSON.parse(missing.stdout).checks;
  assert.equal(missingChecks.find(({ name }) => name === 'gh').status, 'missing');
  assert.equal(missingChecks.find(({ name }) => name === 'opencode').status, 'missing');
  assert.match(missingChecks.find(({ name }) => name === 'opencode').message, /Install opencode/);
  fs.renameSync(path.join(bin, 'gh.disabled'), path.join(bin, 'gh'));
  fs.renameSync(path.join(bin, 'opencode.disabled'), path.join(bin, 'opencode'));

  const store = new SQLiteStore(path.join(home, 'orchestrator.sqlite3'));
  const queued = store.recordEventAndEnqueue({
    project: 'owner/repo', provider: 'github', kind: 'issue', payload: { id: 17 },
    workItemId: 17, title: 'Fixture job', author: 'configured-account', url: 'https://example.test/issues/17',
  });
  const id = Number(queued.job.id);
  store.db.prepare(`UPDATE jobs SET state='FAILED',workflow_state='FAILED',attempts=2,max_attempts=3,
    branch='fix/17',change_number=9,head_sha=?,evidence_commit=?,error_class='FixtureFailure' WHERE id=?`)
    .run('a'.repeat(40), 'b'.repeat(40), id);
  store.db.prepare(`INSERT INTO artifacts(job_id,kind,path,sha256,commit_sha,created_at)
    VALUES (?, 'evidence', 'artifact.log', ?, ?, datetime('now'))`).run(id, 'c'.repeat(64), 'b'.repeat(40));
  store.close();

  const listed = run(['jobs', 'list', '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  const jobs = JSON.parse(listed.stdout);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'FAILED');
  assert.equal(jobs[0].attempts, 2);
  assert.equal(jobs[0].change_number, 9);
  assert.equal(jobs[0].pull_request, 9);
  assert.equal(jobs[0].last_error, 'FixtureFailure');
  assert.equal(jobs[0].evidence.length, 1);
  assert.equal(jobs[0].title, 'Fixture job');
  assert(!Object.hasOwn(jobs[0], 'owner_token'));

  const shown = run(['jobs', 'show', String(id), '--json']);
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), jobs[0]);
  assert.equal(run(['jobs', 'show', '999', '--json']).code, 1);
  const status = JSON.parse(run(['status', '--json']).stdout);
  assert.equal(status.database_path, path.join(home, 'orchestrator.sqlite3'));
  assert.equal(status.queue_counts.FAILED, 1);
  assert.equal(status.queue_counts.READY, 0);
  assert.deepEqual(status.active_leases, []);
  assert.equal(status.next_run, null);
  assert(!JSON.stringify(status).includes('owner_token'));

  // A clean failed job can be retried without changing its history.
  const retryable = storeForOperator(home);
  const queuedRetry = retryable.recordEventAndEnqueue({
    project: 'owner/repo', provider: 'github', kind: 'issue', payload: { id: 18 },
    workItemId: 18, title: 'Retry fixture', author: 'configured-account', url: 'https://example.test/issues/18',
  });
  const retrySource = Number(queuedRetry.job.id);
  retryable.db.prepare("UPDATE jobs SET state='FAILED',workflow_state='FAILED',attempts=1,max_attempts=3 WHERE id=?").run(retrySource);
  retryable.close();
  const retried = run(['jobs', 'retry', String(retrySource), '--json']);
  assert.equal(retried.code, 0, retried.stderr);
  const retryResult = JSON.parse(retried.stdout);
  assert.equal(retryResult.retried, retrySource);
  assert.notEqual(retryResult.job_id, retrySource);
  const verifyRetry = storeForOperator(home);
  assert.equal(verifyRetry.rows('SELECT state FROM jobs WHERE id=?', retrySource)[0].state, 'FAILED');
  assert.equal(verifyRetry.rows('SELECT attempts FROM jobs WHERE id=?', retryResult.job_id)[0].attempts, 1);
  verifyRetry.db.prepare('UPDATE jobs SET attempts=max_attempts WHERE id=?').run(retrySource);
  verifyRetry.close();
  assert.match(run(['jobs', 'retry', String(retrySource)]).stderr, /exhausted max_attempts/);
  const verifyCancel = storeForOperator(home);
  const cancelQueue = verifyCancel.recordEventAndEnqueue({ project: 'owner/repo', provider: 'github', kind: 'issue', payload: { id: 19 }, workItemId: 19, title: 'Cancel fixture' });
  const cancelId = Number(cancelQueue.job.id);
  verifyCancel.close();
  assert.equal(run(['jobs', 'cancel', String(cancelId)]).code, 0);
  assert.match(run(['jobs', 'cancel', String(cancelId)]).stderr, /only READY/);

  const logStore = storeForOperator(home);
  const sessionId = 'safe-session_1';
  const sessionDir = path.join(home, 'agent-sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'events.ndjson'), '{"event":"hello"}\n');
  fs.writeFileSync(path.join(sessionDir, 'stderr.log'), 'fixture stderr\n');
  logStore.db.prepare("INSERT INTO agent_sessions(job_id,session_id,external_session_id,status,ndjson_path,stderr_path,created_at,updated_at) VALUES (?,?,'external','DONE',?,?,datetime('now'),datetime('now'))").run(retryResult.job_id, sessionId, path.join(sessionDir, 'events.ndjson'), path.join(sessionDir, 'stderr.log'));
  logStore.close();
  const logs = run(['logs', '--job', String(retryResult.job_id), '--json']);
  assert.equal(logs.code, 0, logs.stderr);
  assert.equal(JSON.parse(logs.stdout).logs.length, 2);
  assert.doesNotMatch(logs.stdout, /execution_token|owner_token|credential/i);
  const followChild = spawn(process.execPath, [cli, 'logs', '--job', String(retryResult.job_id), '--follow', '--json'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  let followOutput = '', followError = '';
  followChild.stdout.setEncoding('utf8'); followChild.stderr.setEncoding('utf8');
  followChild.stdout.on('data', (chunk) => { followOutput += chunk; });
  followChild.stderr.on('data', (chunk) => { followError += chunk; });
  const snapshotAt = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`logs --follow timed out: ${followError}`)), 3000);
    followChild.stdout.on('data', () => {
      const index = followOutput.indexOf('\n');
      if (index !== -1) { clearTimeout(timeout); resolve(index + 1); }
    });
    followChild.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  fs.appendFileSync(path.join(sessionDir, 'events.ndjson'), '{"event":"follow"}\n');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`logs append event timed out: ${followError}`)), 3000);
    followChild.stdout.on('data', () => {
      if (followOutput.slice(snapshotAt).includes('"event":"append"')) { clearTimeout(timeout); resolve(); }
    });
    followChild.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  followChild.kill('SIGINT');
  await new Promise((resolve, reject) => {
    followChild.once('close', (code, signal) => (code === 0 || signal === 'SIGINT') ? resolve() : reject(new Error(`logs follow exited ${code}/${signal}: ${followError}`)));
  });
  const followLines = followOutput.trim().split('\n').map(JSON.parse);
  assert.equal(followLines[0].event, 'snapshot');
  assert(followLines.slice(1).some((event) => event.event === 'append' && event.content.includes('follow')));
  const outside = path.join(root, 'outside.log'); fs.writeFileSync(outside, 'DO NOT READ');
  const hostile = storeForOperator(home);
  hostile.db.prepare('UPDATE agent_sessions SET stderr_path=? WHERE session_id=?').run(outside, sessionId);
  fs.unlinkSync(path.join(sessionDir, 'events.ndjson'));
  fs.symlinkSync(outside, path.join(sessionDir, 'events.ndjson'));
  hostile.db.prepare('UPDATE agent_sessions SET ndjson_path=? WHERE session_id=?').run(path.join(sessionDir, 'events.ndjson'), sessionId);
  hostile.close();
  const refusedLogs = run(['logs', '--job', String(retryResult.job_id), '--json']);
  assert.deepEqual(JSON.parse(refusedLogs.stdout).logs, []);
  assert.doesNotMatch(refusedLogs.stdout, /DO NOT READ/);
  fs.unlinkSync(path.join(sessionDir, 'events.ndjson'));

  const projectAdd = run(['project', 'add', 'owner/clone', '--from', 'owner/repo', '--json']);
  assert.equal(projectAdd.code, 0, projectAdd.stderr);
  assert.match(fs.readFileSync(config, 'utf8'), /"owner\/repo"/);
  const pause = run(['project', 'pause', 'owner/clone']); assert.equal(pause.code, 0, pause.stderr);
  const resume = run(['project', 'resume', 'owner/clone']); assert.equal(resume.code, 0, resume.stderr);
  const remove = run(['project', 'remove', 'owner/clone']); assert.equal(remove.code, 0, remove.stderr);

  const commentedConfig = path.join(root, 'commented-config.jsonc');
  fs.writeFileSync(commentedConfig, `{
  // root comment must survive edits
  "model": "openai/test-model",
  "accounts": ["configured-account"],
  "repos": {
    // project comment must survive append
    "owner/repo": {
      "account": "configured-account", // account detail
      "dod": ${JSON.stringify(dod)}
    }
  }
}\n`);
  const configEnv = { ISSUE_ORCHESTRATOR_CONFIG: commentedConfig };
  assert.equal(run(['project', 'add', 'owner/second', '--from', 'owner/repo'], configEnv).code, 0);
  const commentedAfterAdd = fs.readFileSync(commentedConfig, 'utf8');
  assert.match(commentedAfterAdd, /root comment must survive edits/);
  assert.match(commentedAfterAdd, /project comment must survive append/);
  assert.equal(run(['project', 'pause', 'owner/second'], configEnv).code, 0);
  assert.equal(run(['project', 'status', 'owner/second'], configEnv).code, 1, 'unsupported project action must refuse without writing');
  assert.equal(run(['project', 'remove', 'owner/second'], configEnv).code, 0);
  const commentedAfterRemove = fs.readFileSync(commentedConfig, 'utf8');
  assert.match(commentedAfterRemove, /root comment must survive edits/);
  assert.doesNotMatch(commentedAfterRemove, /owner\/second/);
  console.log('PASS doctor and jobs CLI provide stable sanitized JSON and actionable dependency/account failures');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
