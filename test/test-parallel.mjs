#!/usr/bin/env node
// Self-test for test/run-parallel.mjs.
//
// The runner executes throwaway scripts from a temp directory via TEST_FILES,
// so this suite never re-runs the real test list. It checks exit codes,
// per-script output blocks, concurrency validation and fail-fast: a script that
// would only start after the first failure must never start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'test/run-parallel.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-orchestrator-parallel-'));

const failMarker = path.join(TMP, 'fail.marker');
const blockerDone = path.join(TMP, 'blocker.done');
const lateMarker = path.join(TMP, 'late.marker');

function script(name, source) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, source);
  return file;
}

const okOne = script('ok-one.mjs', "console.log('ok one output');\n");
const okTwo = script('ok-two.mjs', "console.log('ok two output');\nconsole.error('ok two stderr');\n");
const failing = script('failing.mjs', `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(failMarker)}, 'failed');
console.error('failing script output');
process.exit(1);
`);
// Keeps the second concurrency slot busy until the failing script has really
// failed, so `late` cannot be scheduled before fail-fast triggers.
const blocker = script('blocker.mjs', `import fs from 'node:fs';
const deadline = Date.now() + 10000;
while (!fs.existsSync(${JSON.stringify(failMarker)}) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
// Generous grace so fail-fast registers the failure even on a loaded CI runner.
await new Promise((resolve) => setTimeout(resolve, 2000));
fs.writeFileSync(${JSON.stringify(blockerDone)}, 'done');
console.log('blocker finished after the failure');
`);
const late = script('late.mjs', `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(lateMarker)}, 'started');
console.log('late script must not have started');
`);

function invoke({ files, args = [RUNNER], concurrency = '2' } = {}) {
  const env = { ...process.env };
  delete env.TEST_FILES;
  delete env.TEST_CONCURRENCY;
  if (files !== undefined) env.TEST_FILES = JSON.stringify(files);
  if (concurrency !== null) env.TEST_CONCURRENCY = concurrency;
  return spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
}

function blockCount(stdout, status) {
  return (stdout.match(new RegExp(`^=== ${status} `, 'gm')) ?? []).length;
}

try {
  // All green: both scripts run, both blocks are reported, buffered output is kept.
  const allPass = invoke({ files: [okOne, okTwo] });
  assert.equal(allPass.status, 0, allPass.stderr || allPass.stdout);
  assert.equal(blockCount(allPass.stdout, 'PASS'), 2, allPass.stdout);
  assert.match(allPass.stdout, /2 passed, 0 failed/);
  assert.match(allPass.stdout, /concurrency 2/);
  assert.match(allPass.stdout, /ok one output/);
  assert.match(allPass.stdout, /ok two output/);
  assert.match(allPass.stdout, /ok two stderr/, 'stderr is reported in the same block');

  // A single failure turns into a non-zero exit with an explicit failure list.
  fs.rmSync(failMarker, { force: true });
  const oneFail = invoke({ files: [failing] });
  assert.equal(oneFail.status, 1, oneFail.stdout);
  assert.equal(blockCount(oneFail.stdout, 'FAIL'), 1, oneFail.stdout);
  assert.match(oneFail.stdout, /1 failed/);
  assert.match(oneFail.stdout, /Failed scripts:/);
  assert.match(oneFail.stdout, /failing\.mjs \(exit 1,/);
  assert.match(oneFail.stdout, /failing script output/);

  // Fail-fast: `blocker` and `failing` fill both slots. `late` is only next in
  // line; because the failure is known before blocker releases its slot, it is
  // never spawned and its marker file cannot appear.
  fs.rmSync(failMarker, { force: true });
  fs.rmSync(blockerDone, { force: true });
  fs.rmSync(lateMarker, { force: true });
  const failFast = invoke({ files: [blocker, failing, late] });
  assert.equal(failFast.status, 1, failFast.stdout);
  assert.equal(blockCount(failFast.stdout, 'PASS'), 1, failFast.stdout);
  assert.equal(blockCount(failFast.stdout, 'FAIL'), 1, failFast.stdout);
  assert.ok(fs.existsSync(blockerDone), 'the already running script is awaited');
  assert.equal(fs.existsSync(lateMarker), false, 'no new script starts after the first failure');
  assert.match(failFast.stdout, /Fail-fast: not starting the remaining 1 script\(s\)/);
  assert.match(failFast.stdout, /1 passed, 1 failed, 1 not started/);
  assert.match(failFast.stdout, /blocker finished after the failure/);

  // TEST_CONCURRENCY=1 stays sequential and keeps the list order.
  const sequential = invoke({ files: [okOne, okTwo], concurrency: '1' });
  assert.equal(sequential.status, 0, sequential.stderr || sequential.stdout);
  assert.equal(blockCount(sequential.stdout, 'PASS'), 2, sequential.stdout);
  assert.ok(sequential.stdout.indexOf('ok one output') < sequential.stdout.indexOf('ok two output'));

  // Invalid configuration is rejected instead of silently defaulting.
  for (const bad of ['0', '9', 'two']) {
    const invalid = invoke({ files: [okOne], concurrency: bad });
    assert.equal(invalid.status, 2, `TEST_CONCURRENCY=${JSON.stringify(bad)} must fail: ${invalid.stdout}`);
    assert.match(invalid.stderr, /TEST_CONCURRENCY must be an integer between 1 and 8/);
  }
  const emptyFiles = invoke({ files: [] });
  assert.equal(emptyFiles.status, 2);
  assert.match(emptyFiles.stderr, /TEST_FILES must be a non-empty JSON array/);

  // The runner refuses to schedule itself, whatever way it is addressed.
  const recursive = invoke({ files: [RUNNER] });
  assert.equal(recursive.status, 2, recursive.stdout);
  assert.match(recursive.stderr, /recursively/);

  // CLI filters must name scripts from the canonical list.
  const unknown = invoke({ args: [RUNNER, 'test/not-a-test.mjs'] });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown test/);

  console.log('PASS parallel runner: buffered blocks, concurrency limit, validation and fail-fast');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
