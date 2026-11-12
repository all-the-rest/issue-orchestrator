import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist/cli.js');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-cli-'));
const home = path.join(sandbox, 'home');
const runtime = path.join(sandbox, 'runtime');
fs.mkdirSync(home, { mode: 0o700 });
fs.mkdirSync(runtime, { mode: 0o700 });

function tree(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      return `${path.relative(directory, full)}:${entry.isDirectory() ? 'dir' : 'file'}`;
    })
    .sort();
}

const before = tree(sandbox);
const hiddenToken = `ghp_${'A'.repeat(36)}`;
const hiddenModelKey = `sk-${'B'.repeat(24)}`;
const environment = {
  ...process.env,
  HOME: home,
  ISSUE_ORCHESTRATOR_HOME: runtime,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  GH_TOKEN: hiddenToken,
  GITHUB_TOKEN: hiddenToken,
  OPENCODE_API_KEY: hiddenModelKey,
};
delete environment.ISSUE_ORCHESTRATOR_CONFIG;
delete environment.OPENCODE_CONFIG;
delete environment.GH_CONFIG_DIR;

const printed = spawnSync(process.execPath, [cli, 'setup', '--print'], {
  cwd: sandbox, env: environment, encoding: 'utf8',
});
assert.equal(printed.status, 0, printed.stderr);
assert.equal(printed.stderr, '');
const text = printed.stdout;
assert.equal(tree(sandbox).join('\n'), before.join('\n'), 'setup --print must not create or change files');

// The guidance must stay actionable for an agent following it, and must not
// drift back to an OpenCode skill/slash-command-only setup path.
for (const phrase of [
  'issue-orchestrator.git',
  'pnpm build',
  'gh auth login --hostname github.com',
  'agent_runner: "opencode"',
  'trusted_authors',
  'tickets poll --dry-run',
  'build-worker',
  'deny the question tool',
  'GitHub comment',
  'opencode auth login',
  'OPENCODE_DATA_DIR',
  'GH_CONFIG_DIR',
  'ISSUE_ORCHESTRATOR_RUNTIME_BIN',
  'unless-stopped',
  'deploy/systemd/docker.env.example',
  'deploy/systemd/issue-orchestrator-docker.service',
  'systemctl enable --now docker',
  'systemctl enable --now issue-orchestrator-docker.service',
  'docker compose down -v',
  'no OpenCode skill or slash-command override',
]) {
  assert.ok(text.includes(phrase), `setup guidance must mention ${JSON.stringify(phrase)}`);
}

// Every referenced document must actually exist in the shipped source tree.
const references = [...new Set(
  [...text.matchAll(/(?:docs|deploy)\/[A-Za-z0-9._/-]+\.md/g)].map((match) => match[0]),
)];
assert.ok(references.includes('docs/service.md'));
for (const reference of references) {
  assert.ok(fs.existsSync(path.join(root, reference)), `setup guidance references missing ${reference}`);
}

// No credential-shaped output.
assert.doesNotMatch(text, /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{16,})\b/);
assert.doesNotMatch(text, /password|private key|BEGIN [A-Z ]+PRIVATE KEY/i);
assert.ok(!text.includes(hiddenToken) && !text.includes(hiddenModelKey), 'setup must not echo environment credentials');

// The command is print-only: arbitrary arguments or a missing --print fail
// closed instead of silently reading config or writing guidance somewhere.
for (const args of [
  ['setup'],
  ['setup', '--print', '--config', path.join(sandbox, 'config.jsonc')],
  ['setup', '--print', 'extra'],
  ['setup', '--print=1'],
]) {
  const refused = spawnSync(process.execPath, [cli, ...args], {
    cwd: sandbox, env: environment, encoding: 'utf8',
  });
  assert.notEqual(refused.status, 0, `${args.join(' ')} must fail`);
  assert.match(refused.stderr, /usage: setup --print/);
  assert.equal(refused.stdout, '');
}

const help = spawnSync(process.execPath, [cli, '--help'], { cwd: sandbox, env: environment, encoding: 'utf8' });
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /setup --print\s+print agent-consumable setup guidance/);

fs.rmSync(sandbox, { recursive: true });
console.log('PASS setup --print guidance (static, secret-free, write-free)');
