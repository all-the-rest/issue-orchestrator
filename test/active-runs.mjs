import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createTrackedAgentRun, requestRunShutdown, shutdownRequested, trackAgentRun } from '../dist/core/active-runs.js';

const activeRunsUrl = new URL('../dist/core/active-runs.js', import.meta.url).href;

const aborted = [];
const settled = [];
const makeRun = (sessionId, failAbort = false) => {
  let finish;
  const promise = new Promise((resolve) => { finish = resolve; });
  const release = trackAgentRun({
    sessionId,
    promise,
    runner: {
      async abort({ sessionId: target }) {
        aborted.push(target);
        if (failAbort) {
          finish(target);
          throw new Error(`abort failed for ${target}`);
        }
        settled.push(target);
        finish(target);
        return true;
      },
    },
  });
  return { release, promise, finish };
};

const first = makeRun('session-one');
const second = makeRun('session-two');
const failing = makeRun('session-three', true);
assert.equal(shutdownRequested(), null);

await assert.rejects(requestRunShutdown('SIGTERM'), /abort failed for session-three/);
assert.equal(shutdownRequested(), 'SIGTERM');
assert.deepEqual(aborted, ['session-one', 'session-two', 'session-three'],
  'one signal aborts every active session, not only the most recent');
assert.deepEqual(settled, ['session-one', 'session-two']);
assert.equal(await first.promise, 'session-one');
assert.equal(await second.promise, 'session-two');

// Releasing a finished run must not remove another run from the registry.
first.release();
second.release();
failing.finish('session-three');
failing.release();
assert.equal(shutdownRequested(), 'SIGTERM');

// A signal can land after registration but before the runner starts. The gate
// must settle so shutdown does not hang, and the runner must never start.
let gatedStarted = false;
let gatedAborted = false;
const gated = createTrackedAgentRun({
  async abort({ sessionId: target }) { gatedAborted = target === 'session-gated'; return true; },
}, 'session-gated', async () => { gatedStarted = true; return 'started'; });
const shutdown = requestRunShutdown('SIGTERM');
gated.fail(new Error('shutdown before runner start'));
await shutdown;
assert.equal(gatedAborted, true, 'a registered-but-not-started run is abortable');
assert.equal(gatedStarted, false, 'shutdown before start must not launch the runner');
await assert.rejects(gated.promise, /shutdown before runner start/);
gated.release();

// A shutdown signal snapshotted before registration leaves the gate rejection
// without a requestRunShutdown waiter. A child process proves Node sees it as
// handled rather than exiting with ERR_UNHANDLED_REJECTION.
const childCode = `
  import { createTrackedAgentRun } from ${JSON.stringify(activeRunsUrl)};
  const run = createTrackedAgentRun({ async abort() { return true; } }, 'orphan-session',
    async () => 'started');
  run.fail(new Error('shutdown before registration'));
  await new Promise((resolve) => setTimeout(resolve, 100));
`;
const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childErr = '';
child.stderr.on('data', (part) => { childErr += part; });
const childExit = await new Promise((resolve) => child.on('close', resolve));
assert.equal(childExit, 0, `gate rejection must not crash the process: ${childErr}`);
assert.doesNotMatch(childErr, /unhandled|ERR_UNHANDLED_REJECTION/i);

console.log('active-run registry aborts all parallel sessions on shutdown');
