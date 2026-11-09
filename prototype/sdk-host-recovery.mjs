#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Prototype process-group test supports Linux/macOS only');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-orchestrator-sdk-prototype-'));
fs.chmodSync(root, 0o700);
const data = path.join(root, 'data');
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'home');
const config = path.join(root, 'xdg-config');
const runtime = path.join(root, 'xdg-runtime');
for (const dir of [data, workspace, home, config, runtime]) fs.mkdirSync(dir, { mode: 0o700 });
const sessionId = `ses_${randomUUID().replaceAll('-', '')}`;
const record = path.join(root, 'session-id.json');
const recordFd = fs.openSync(record, 'wx', 0o600);
try {
  fs.writeFileSync(recordFd, `${JSON.stringify({ sessionId })}\n`);
  fs.fsyncSync(recordFd);
} finally {
  fs.closeSync(recordFd);
}
const rootFd = fs.openSync(root, 'r');
try { fs.fsyncSync(rootFd); }
finally { fs.closeSync(rootFd); }
const worker = fileURLToPath(new URL('./sdk-host-worker.mjs', import.meta.url));
const env = { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), XDG_RUNTIME_DIR: runtime, PATH: '' };
let active;
const MAX_PROTOCOL_BYTES = 16 * 1024;

function launch(mode) {
  const child = fork(worker, [mode, sessionId, data, workspace], {
    cwd: workspace, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true,
  });
  child.lines = [];
  child.mode = mode;
  active = child;
  return child;
}
function waitMessage(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`SDK worker protocol timed out (${child.mode}); exit=${child.exitCode}/${child.signalCode}`)), 15_000);
    const check = () => {
      if (child.lines.length) {
        clearTimeout(timeout);
        const message = JSON.parse(child.lines.shift());
        if (message.type === 'error') reject(new Error(message.message));
        else resolve(message);
      }
    };
    child.on('message', (message) => {
      const encoded = JSON.stringify(message);
      if (Buffer.byteLength(encoded) > MAX_PROTOCOL_BYTES) {
        child.protocolError = new Error('SDK worker protocol exceeded 16 KiB');
        child.kill('SIGKILL');
        return;
      }
      child.lines.push(encoded);
      check();
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    check();
  });
}
function exited(child) {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
}
async function stopGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await exited(child);
}

try {
  const chosen = JSON.parse(fs.readFileSync(record, 'utf8')).sessionId;
  assert.equal(chosen, sessionId, 'session ID is durably recorded before host launch');
  assert.equal(fs.statSync(record).mode & 0o777, 0o600, 'session ID record is private');
  let start = performance.now();
  let first = launch('create');
  const created = await waitMessage(first);
  const initialReadyMs = performance.now() - start;
  assert.equal(created.type, 'ready');
  assert.equal(created.sessionId, sessionId);
  first.send({ type: 'shutdown' });
  assert.equal((await waitMessage(first)).type, 'closed');
  const normal = await exited(first);
  assert.equal(normal.code, 0);
  active = undefined;

  start = performance.now();
  let doomed = launch('hold');
  const existing = await waitMessage(doomed);
  assert.equal(existing.type, 'held');
  assert.equal(existing.sessionId, sessionId);
  await stopGroup(doomed, 'SIGKILL');
  assert.equal(doomed.exitCode, null, 'abruptly killed worker did not exit normally');
  assert.equal(doomed.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(doomed.pid, 0), { code: 'ESRCH' }, 'previous worker is stopped before replacement');
  assert.throws(() => process.kill(-doomed.pid, 0), { code: 'ESRCH' }, 'previous worker process group is stopped before replacement');
  active = undefined;

  start = performance.now();
  const replacement = launch('get');
  const recovered = await waitMessage(replacement);
  const restartQueryMs = performance.now() - start;
  assert.equal(recovered.type, 'recovered');
  assert.equal(recovered.sessionId, chosen);
  const replaced = await exited(replacement);
  assert.equal(replaced.code, 0);
  active = undefined;
  console.log(JSON.stringify({
    result: 'PASS', sdkVersion: recovered.version, sessionId: chosen,
    endToEndInitialReadyAndCreateMs: Math.round(initialReadyMs), hostReadyMs: Math.round(created.hostReadyMs),
    sessionCreateMs: Math.round(created.createMs), restartHostReadyMs: Math.round(recovered.hostReadyMs),
    restartSessionQueryMs: Math.round(recovered.queryMs), restartEndToEndMs: Math.round(restartQueryMs),
    abruptWorkerExit: doomed.signalCode, previousChildStoppedBeforeReplacement: true,
  }, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
} catch (error) {
  if (active) await stopGroup(active, 'SIGKILL').catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
  throw error;
}
