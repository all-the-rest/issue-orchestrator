#!/usr/bin/env node
// Runs the standalone test scripts concurrently.
//
// Every script is hermetic: scripts that touch the filesystem work in their
// own `mkdtempSync` directory and none changes the shared process cwd. The list below is the same set and
// order that used to be a sequential `&&` chain in `package.json`; only the
// scheduling is new. Output is buffered per script and printed as one block
// after it finishes, so failures stay readable.
//
// Usage:
//   node test/run-parallel.mjs                 # full list, TEST_CONCURRENCY (default 4)
//   node test/run-parallel.mjs test/e2e.mjs    # only the named scripts from the list
//   TEST_FILES='["test/e2e.mjs"]' node test/run-parallel.mjs
//
// `TEST_FILES` exists so `test/test-parallel.mjs` can exercise this runner with
// throwaway scripts. It replaces the list and therefore does not have to name
// entries of it, but it may never contain the runner itself.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const SELF_NAME = path.relative(ROOT, SELF);
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

const TESTS = [
  'test/evidence-capture.mjs',
  'test/evidence-validation.mjs',
  'test/operator-cli.mjs',
  'test/setup-cli.mjs',
  'test/service.mjs',
  'test/code-dev-deployment.mjs',
  'test/e2e.mjs',
  'test/run-once.mjs',
  'test/skill-wrapper.mjs',
  'test/goal-cli.mjs',
  'test/repository-discovery.mjs',
  'test/delivery-window.mjs',
  'test/event-metadata.mjs',
  'test/ticket-handoff.mjs',
  'test/github-ticket.mjs',
  'test/ticket-runtime.mjs',
  'test/persistence.mjs',
  'test/ticket-dispatch.mjs',
  'test/ticket-activation.mjs',
  'test/active-runs.mjs',
  'test/agent-runner-contract.mjs',
  'test/command-runner.mjs',
  'test/opencode-runner.mjs',
  'test/test-parallel.mjs',
];

function abort(message) {
  process.stderr.write(`test/run-parallel.mjs: ${message}\n`);
  process.exit(2);
}

function readConcurrency() {
  const raw = process.env.TEST_CONCURRENCY;
  if (raw === undefined || raw === '') return DEFAULT_CONCURRENCY;
  if (!/^[1-8]$/.test(raw)) {
    abort(`TEST_CONCURRENCY must be an integer between 1 and ${MAX_CONCURRENCY}, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

function displayPath(absolute) {
  const relative = path.relative(ROOT, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : absolute;
}

function sameFile(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function selectTests() {
  const override = process.env.TEST_FILES;
  const requested = [];
  if (override !== undefined && override !== '') {
    let parsed;
    try {
      parsed = JSON.parse(override);
    } catch {
      abort('TEST_FILES must be a JSON array of test paths');
    }
    if (!Array.isArray(parsed) || parsed.length === 0) abort('TEST_FILES must be a non-empty JSON array of test paths');
    for (const entry of parsed) {
      if (typeof entry !== 'string' || entry === '') abort('TEST_FILES entries must be non-empty strings');
      requested.push(path.resolve(ROOT, entry));
    }
  } else if (process.argv.length > 2) {
    for (const argument of process.argv.slice(2)) {
      const absolute = path.resolve(ROOT, argument);
      const name = displayPath(absolute);
      if (!TESTS.includes(name)) {
        abort(`unknown test ${JSON.stringify(argument)}; expected one of: ${TESTS.join(', ')}`);
      }
      requested.push(absolute);
    }
  } else {
    requested.push(...TESTS.map((name) => path.join(ROOT, name)));
  }

  const tests = [];
  const seen = new Set();
  for (const absolute of requested) {
    // Never let a test invocation re-enter the runner: that would fork forever.
    if (sameFile(absolute, SELF) || (fs.existsSync(absolute) && sameFile(fs.realpathSync(absolute), fs.realpathSync(SELF)))) {
      abort(`refusing to run ${SELF_NAME} recursively`);
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      abort(`test script not found: ${displayPath(absolute)}`);
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    tests.push({ file: absolute, name: displayPath(absolute) });
  }
  return tests;
}

function formatDuration(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatExit(code, signal) {
  return signal ? `signal ${signal}` : `exit ${code}`;
}

const activeChildren = new Set();

function runTest(test) {
  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = '';
    let stderr = '';
    process.stdout.write(`RUN  ${test.name}\n`);
    const child = spawn(process.execPath, [test.file], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const finish = (code, signal, error) => {
      activeChildren.delete(child);
      if (error) stderr += `${error.stack ?? error}\n`;
      resolve({
        ...test,
        code,
        signal,
        stdout,
        stderr,
        ok: !error && !signal && code === 0,
        durationMs: performance.now() - started,
      });
    };
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function printResult(result) {
  const status = result.ok ? 'PASS' : 'FAIL';
  const head = `\n=== ${status} ${result.name} (${formatExit(result.code, result.signal)}, ${formatDuration(result.durationMs)}) ===\n`;
  process.stdout.write(head);
  for (const chunk of [result.stdout, result.stderr]) {
    if (!chunk) continue;
    process.stdout.write(chunk);
    if (!chunk.endsWith('\n')) process.stdout.write('\n');
  }
}

async function main() {
  const concurrency = readConcurrency();
  const tests = selectTests();
  const started = performance.now();
  process.stdout.write(`test/run-parallel.mjs: ${tests.length} script(s), concurrency ${concurrency}\n`);

  const results = [];
  let next = 0;
  let stopping = false;
  let killedBy = null;

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (killedBy) return;
      killedBy = signal;
      stopping = true;
      for (const child of activeChildren) child.kill(signal);
      const timer = setTimeout(() => {
        for (const child of activeChildren) child.kill('SIGKILL');
      }, 5000);
      timer.unref();
    });
  }

  const worker = async () => {
    for (;;) {
      if (stopping) return;
      const index = next;
      next += 1;
      const test = tests[index];
      if (!test) return;
      const result = await runTest(test);
      results.push(result);
      printResult(result);
      if (!result.ok) {
        const remaining = tests.length - next;
        if (!stopping && remaining > 0) {
          process.stdout.write(`\nFail-fast: not starting the remaining ${remaining} script(s).\n`);
        }
        stopping = true;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tests.length) }, () => worker()));

  const failed = results.filter((result) => !result.ok);
  const passed = results.length - failed.length;
  const notStarted = tests.length - results.length;
  const total = performance.now() - started;
  const counts = [
    `${passed} passed`,
    `${failed.length} failed`,
    ...(notStarted > 0 ? [`${notStarted} not started`] : []),
  ].join(', ');
  const summary = `${counts} in ${formatDuration(total)} (concurrency ${concurrency})`;
  process.stdout.write(`\ntest/run-parallel.mjs: ${summary}\n`);
  if (failed.length > 0) {
    process.stdout.write('Failed scripts:\n');
    for (const result of failed) {
      process.stdout.write(`  ${result.name} (${formatExit(result.code, result.signal)}, ${formatDuration(result.durationMs)})\n`);
    }
  }
  process.exitCode = killedBy ? 128 + (killedBy === 'SIGINT' ? 2 : 15) : failed.length > 0 ? 1 : 0;
}

await main();
