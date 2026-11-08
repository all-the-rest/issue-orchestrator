import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureCommand } from '../dist/evidence/capture.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-capture-'));
try {
  const output = path.join(root, 'capture.log');
  const argv = [process.execPath, '-e', 'process.stdout.write(process.argv[1]);process.stderr.write(String.fromCharCode(10)+"err")', 'literal;not-shell'];
  assert.equal(await captureCommand(argv, output), 0);
  assert.equal(fs.readFileSync(output, 'utf8'), 'literal;not-shell\nerr');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${output}.json`, 'utf8')), { command: argv, exit_code: 0 });

  const failed = path.join(root, 'failure.log');
  const failedArgv = [process.execPath, '-e', 'process.stdout.write("failed");process.exit(7)'];
  assert.equal(await captureCommand(failedArgv, failed), 7);
  assert.equal(fs.readFileSync(failed, 'utf8'), 'failed');
  assert.equal(JSON.parse(fs.readFileSync(`${failed}.json`, 'utf8')).exit_code, 7);
  const fullDisk = path.join(root, 'full-disk.log');
  const originalWriteSync = fs.writeSync;
  fs.writeSync = function (fd, data, ...args) {
    if (Buffer.isBuffer(data) && data.toString() === 'disk-full') throw new Error('injected disk-full write');
    return originalWriteSync.call(fs, fd, data, ...args);
  };
  const stubbornPid = path.join(root, 'stubborn.pid');
  try {
    await assert.rejects(
      captureCommand([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(stubbornPid)},String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write("disk-full");setInterval(()=>{},1000)`], fullDisk),
      /injected disk-full write/,
    );
  } finally {
    fs.writeSync = originalWriteSync;
  }
  const stubbornPidNumber = Number(fs.readFileSync(stubbornPid, 'utf8'));
  let childAlive = true;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(stubbornPidNumber, 0); }
    catch (error) { if (error.code === 'ESRCH') childAlive = false; else throw error; }
    if (!childAlive) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(childAlive, false, 'write failure must kill a child that ignores SIGTERM');
  assert.equal(fs.existsSync(`${fullDisk}.json`), false, 'failed capture must not publish a success sidecar');
  assert.throws(() => captureCommand(argv, output), /EEXIST/);
  console.log('PASS portable shell-free capture preserves argv/outcomes and aborts safely on write failure');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
