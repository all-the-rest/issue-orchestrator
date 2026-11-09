import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist/cli.js');
const oddCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'service path "quoted" '));
const result = spawnSync(process.execPath, [cli, 'service', 'install', '--print'], { cwd: oddCwd, encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
if (process.platform === 'darwin') {
  assert.match(result.stdout, /<string>run<\/string><string>--once<\/string>/);
  const file = path.join(os.tmpdir(), `issue-orchestrator-${process.pid}.plist`);
  fs.writeFileSync(file, result.stdout.slice(0, result.stdout.indexOf('\n\nSave as')));
  const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
  fs.unlinkSync(file);
  assert.equal(lint.status, 0, lint.stderr || lint.stdout);
  assert.match(result.stdout, /launchctl bootstrap gui/);
} else if (process.platform === 'linux') {
  assert.match(result.stdout, /run --once/);
  assert.match(result.stdout, /systemctl --user enable --now issue-orchestrator.timer/);
  assert.match(result.stdout, /WorkingDirectory=.*\\s.*\\x22quoted\\x22/);
  assert.match(result.stdout, /Environment="PATH=/);
  const service = result.stdout.match(/\[Unit\]\nDescription=Issue Orchestrator[\s\S]*?(?=\n\n# Save as)/)?.[0];
  const timer = result.stdout.match(/# Save as .*issue-orchestrator\.timer\n([\s\S]*?)(?=\n\nSave both files)/)?.[1];
  assert.ok(service && timer, 'both systemd unit templates printed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-orchestrator-units-'));
  fs.writeFileSync(path.join(dir, 'issue-orchestrator.service'), service);
  fs.writeFileSync(path.join(dir, 'issue-orchestrator.timer'), timer);
  const verify = spawnSync('systemd-analyze', ['verify', 'issue-orchestrator.service', 'issue-orchestrator.timer'], { cwd: dir, encoding: 'utf8' });
  if (verify.error?.code !== 'ENOENT') assert.equal(verify.status, 0, verify.stderr);
  fs.rmSync(dir, { recursive: true });
}
const invalid = spawnSync(process.execPath, [cli, 'service', 'install'], { cwd: oddCwd, encoding: 'utf8' });
assert.notEqual(invalid.status, 0);
assert.match(invalid.stderr, /usage: service install --print/);
for (const interval of ['0', '59', 'not-a-number']) {
  const worker = spawnSync('sh', [path.join(root, 'docker/worker.sh')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ISSUE_ORCHESTRATOR_INTERVAL_SECONDS: interval },
  });
  assert.equal(worker.status, 64, `invalid interval ${interval} must fail instead of starting a hot loop`);
}
fs.rmSync(oddCwd, { recursive: true });
console.log(`PASS service template print (${process.platform})`);
