import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SQLiteStore } from '../dist/core/persistence.js';

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
  model: 'openai/test-model', accounts: ['configured-account'],
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
  console.log('PASS doctor and jobs CLI provide stable sanitized JSON and actionable dependency/account failures');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
