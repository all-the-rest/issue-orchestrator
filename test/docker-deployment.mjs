import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = path.join(root, 'docker/worker.sh');
const temporaryRoots = [];

function temporary(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

function write(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

function executable(file, content) {
  write(file, content, 0o755);
}

function deploymentFixture() {
  const home = temporary('issue-orchestrator-home-');
  const repo = temporary('issue-orchestrator-repo-');
  const gh = path.join(home, '.config/gh');
  const data = path.join(home, '.local/share/opencode');
  const bin = path.join(home, 'bin');
  const log = path.join(home, 'cli.log');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin, { recursive: true, mode: 0o755 });
  write(path.join(home, '.config/opencode/opencode.jsonc'), '{}\n', 0o600);
  write(path.join(gh, 'hosts.yml'), 'github.com:\n  user: unpublished-credential-marker\n', 0o600);
  fs.chmodSync(gh, 0o700);
  executable(path.join(bin, 'gh'), '#!/bin/sh\nexit 0\n');
  executable(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n');
  executable(path.join(bin, 'git'), '#!/bin/sh\nexit 0\n');
  const cli = path.join(home, 'fake-cli.mjs');
  write(cli, `
import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.on('SIGTERM', () => {
  fs.appendFileSync(process.env.FAKE_LOG, 'TERM\\n');
  process.exit(143);
});
process.on('SIGINT', () => {
  fs.appendFileSync(process.env.FAKE_LOG, 'INT\\n');
  process.exit(130);
});
if (process.env.FAKE_STAY_ALIVE === '1') setInterval(() => {}, 1000);
else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`, 0o600);
  const config = path.join(home, '.config/issue-orchestrator/config.jsonc');
  write(config, '{ "repos": {} }\n', 0o600);
  return { home, repo, gh, data, bin, log, cli, config };
}

function workerEnv(fixture, overrides = {}) {
  return {
    ...process.env,
    HOME: fixture.home,
    PATH: `${fixture.bin}:${process.env.PATH}`,
    ISSUE_ORCHESTRATOR_REPO: fixture.repo,
    ISSUE_ORCHESTRATOR_NODE_BIN: process.execPath,
    ISSUE_ORCHESTRATOR_CLI: fixture.cli,
    ISSUE_ORCHESTRATOR_CONFIG: fixture.config,
    GH_CONFIG_DIR: fixture.gh,
    OPENCODE_CONFIG: path.join(fixture.home, '.config/opencode/opencode.jsonc'),
    FAKE_LOG: fixture.log,
    ...overrides,
  };
}

function run(fixture, args, overrides = {}) {
  return spawnSync('sh', [worker, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: workerEnv(fixture, overrides),
    timeout: 20_000,
  });
}

function cliCalls(fixture) {
  if (!fs.existsSync(fixture.log)) return [];
  return fs.readFileSync(fixture.log, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => line === 'TERM' || line === 'INT' ? line : JSON.parse(line));
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for worker state');
}

const fixture = deploymentFixture();

// Router is the default mode and receives validated project/max arguments.
let result = run(fixture, ['--once'], {
  ISSUE_ORCHESTRATOR_MODE: 'router',
  ISSUE_ORCHESTRATOR_PROJECT: 'owner/repository',
  ISSUE_ORCHESTRATOR_MAX: '25',
});
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(cliCalls(fixture).at(-1), ['tickets', 'poll', '--project', 'owner/repository', '--max', '25']);
assert.match(result.stdout, /mode=router/);

// Default mode stays router when the variable is absent.
fs.rmSync(fixture.log, { force: true });
result = run(fixture, ['--once']);
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(cliCalls(fixture).at(-1), ['tickets', 'poll']);

// A failed cycle's status is propagated for one-shot smoke tests.
fs.rmSync(fixture.log, { force: true });
result = run(fixture, ['--once'], { FAKE_EXIT: '7' });
assert.equal(result.status, 7);
assert.deepEqual(cliCalls(fixture).at(-1), ['tickets', 'poll']);

// The legacy builder remains available but is opt-in.
fs.rmSync(fixture.log, { force: true });
result = run(fixture, ['--once'], {
  ISSUE_ORCHESTRATOR_MODE: 'builder',
  ISSUE_ORCHESTRATOR_PROJECT: 'owner/repository',
});
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(cliCalls(fixture).at(-1), ['run', '--once', '--project', 'owner/repository']);

// Invalid mode and invalid numeric limits fail closed without starting a CLI.
for (const overrides of [
  { ISSUE_ORCHESTRATOR_MODE: 'daemon' },
  { ISSUE_ORCHESTRATOR_PROJECT: '../escape' },
  { ISSUE_ORCHESTRATOR_MAX: '0' },
  { ISSUE_ORCHESTRATOR_MAX: '1001' },
  { ISSUE_ORCHESTRATOR_MAX: 'ten' },
]) {
  fs.rmSync(fixture.log, { force: true });
  result = run(fixture, ['--once'], overrides);
  assert.equal(result.status, 64, `${JSON.stringify(overrides)} must exit 64: ${result.stderr}`);
  assert.deepEqual(cliCalls(fixture), []);
}

// Missing config and unsafe credentials fail before the CLI runs.
fs.rmSync(fixture.log, { force: true });
result = run(fixture, ['--once'], { ISSUE_ORCHESTRATOR_CONFIG: path.join(fixture.home, 'missing.jsonc') });
assert.equal(result.status, 78);
assert.match(result.stderr, /Issue Orchestrator config/);
assert.deepEqual(cliCalls(fixture), []);
assert.doesNotMatch(`${result.stdout}${result.stderr}`, /unpublished-credential-marker/);

fs.chmodSync(path.join(fixture.gh, 'hosts.yml'), 0o644);
result = run(fixture, ['--once']);
assert.equal(result.status, 78);
assert.match(result.stderr, /hosts\.yml must be mode 0600/);
assert.doesNotMatch(`${result.stdout}${result.stderr}`, /unpublished-credential-marker/);
fs.chmodSync(path.join(fixture.gh, 'hosts.yml'), 0o600);

fs.chmodSync(fixture.gh, 0o770);
result = run(fixture, ['--once']);
assert.equal(result.status, 78);
assert.match(result.stderr, /group\/other writable/);
fs.chmodSync(fixture.gh, 0o700);

// A missing runtime executable is a startup failure, not a hot loop.
const noRuntimeBin = temporary('issue-orchestrator-empty-bin-');
result = run(fixture, ['--once'], {
  PATH: `${noRuntimeBin}:/usr/bin:/bin`,
  ISSUE_ORCHESTRATOR_NODE_BIN: process.execPath,
});
assert.equal(result.status, 69);
assert.match(result.stderr, /required executable/);

// SIGTERM reaches the active CLI process and the worker exits cleanly.
fs.rmSync(fixture.log, { force: true });
const running = spawn('sh', [worker], {
  cwd: root,
  env: workerEnv(fixture, {
    ISSUE_ORCHESTRATOR_INTERVAL_SECONDS: '60',
    FAKE_STAY_ALIVE: '1',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let runningOutput = '';
running.stdout.on('data', (chunk) => { runningOutput += chunk; });
running.stderr.on('data', (chunk) => { runningOutput += chunk; });
try {
  await waitFor(() => cliCalls(fixture).length > 0);
  running.kill('SIGTERM');
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not stop after SIGTERM')), 10_000);
    running.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(exit.code, 0, `worker exit after SIGTERM: ${JSON.stringify(exit)}\n${runningOutput}`);
  assert.ok(cliCalls(fixture).includes('TERM'), 'the CLI process received SIGTERM');
} finally {
  if (running.exitCode === null) running.kill('SIGKILL');
}

// A failed cycle waits for the configured interval instead of hot-looping.
fs.rmSync(fixture.log, { force: true });
const failing = spawn('sh', [worker], {
  cwd: root,
  env: workerEnv(fixture, {
    ISSUE_ORCHESTRATOR_INTERVAL_SECONDS: '60',
    FAKE_EXIT: '1',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  await waitFor(() => cliCalls(fixture).length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(cliCalls(fixture).filter((call) => Array.isArray(call)).length, 1,
    'a failed cycle must not restart before the interval elapses');
  failing.kill('SIGTERM');
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('failing worker did not stop')), 10_000);
    failing.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(exit, 0);
} finally {
  if (failing.exitCode === null) failing.kill('SIGKILL');
}

// Compose must stay non-privileged, restart automatically, and mount provider
// credentials read-only. These assertions are static so they also run on
// hosts without a Docker daemon.
const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
assert.match(compose, /restart: unless-stopped/);
assert.match(compose, /ISSUE_ORCHESTRATOR_MODE: \$\{ISSUE_ORCHESTRATOR_MODE:-router\}/);
assert.match(compose, /no-new-privileges:true/);
assert.match(compose, /\/home\/node\/\.config\/gh:ro/);
assert.match(compose, /\/home\/node\/\.config\/opencode\/opencode\.jsonc:ro/);
assert.match(compose, /\.local\/share\/opencode:ro/);
assert.doesNotMatch(compose, /docker\.sock|privileged:\s*true/);

const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
if (composeAvailable) {
  const docker = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCODE_CONFIG: path.join(fixture.home, '.config/opencode/opencode.jsonc'),
      OPENCODE_DATA_DIR: fixture.data,
      GH_CONFIG_DIR: fixture.gh,
      ISSUE_ORCHESTRATOR_WORKSPACE: fixture.repo,
      ISSUE_ORCHESTRATOR_CONFIG_FILE: fixture.config,
      ISSUE_ORCHESTRATOR_RUNTIME_BIN: fixture.bin,
    },
  });
  assert.equal(docker.status, 0, docker.stderr);
  const service = JSON.parse(docker.stdout).services.worker;
  assert.equal(service.restart, 'unless-stopped');
  assert.equal(service.init, true);
  assert.equal(service.user, '1000:1000');
  assert.ok(service.security_opt.includes('no-new-privileges:true'));
  assert.equal(service.environment.ISSUE_ORCHESTRATOR_MODE, 'router');
  const readOnly = new Set(service.volumes.filter((volume) => volume.read_only).map((volume) => volume.target));
  assert.ok(readOnly.has('/home/node/.config/gh'));
  assert.ok(readOnly.has('/home/node/.config/opencode/opencode.jsonc'));
  assert.ok(readOnly.has('/home/node/.local/share/opencode'));
  assert.ok(readOnly.has('/home/node/.config/issue-orchestrator/config.jsonc'));
  assert.ok(!readOnly.has('/workspace'));
}

// The host unit starts the compose project after boot and never carries
// credential values.
const unit = fs.readFileSync(path.join(root, 'deploy/systemd/issue-orchestrator-docker.service'), 'utf8');
assert.match(unit, /^Requires=docker\.service$/m);
assert.match(unit, /^After=docker\.service network-online\.target$/m);
assert.match(unit, /^EnvironmentFile=-\/etc\/issue-orchestrator\/docker\.env$/m);
assert.match(unit, /^ExecStart=\/usr\/bin\/docker compose up -d --remove-orphans$/m);
assert.match(unit, /^ExecStop=\/usr\/bin\/docker compose down$/m);
assert.match(unit, /^WantedBy=multi-user\.target$/m);
assert.doesNotMatch(unit, /TOKEN|PASSWORD|SECRET|docker\.sock/);

const envExample = fs.readFileSync(path.join(root, 'deploy/systemd/docker.env.example'), 'utf8')
  .split('\n').filter((line) => !line.startsWith('#')).join('\n');
assert.match(envExample, /^ISSUE_ORCHESTRATOR_WORKSPACE=\//m);
assert.doesNotMatch(envExample, /TOKEN|PASSWORD|SECRET|BEGIN .*PRIVATE KEY/);

for (const directory of temporaryRoots) fs.rmSync(directory, { recursive: true, force: true });
console.log('PASS docker router start, fail-closed preflight, restart and autostart config');
