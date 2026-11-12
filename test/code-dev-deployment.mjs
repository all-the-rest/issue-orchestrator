import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Static, fake-docker and Linux process checks for the existing code-dev
// deployment. They never touch a Docker daemon, a real container, or a real
// credential.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deploy = path.join(root, 'deploy/code-dev');
const systemd = path.join(root, 'deploy/systemd');
const scripts = [
  'lib.sh', 'check.sh', 'container-entrypoint.sh', 'stop-container.sh',
  'preflight.sh', 'run.sh', 'stop.sh', 'init-state.sh',
];

for (const name of scripts) {
  const file = path.join(deploy, name);
  assert.ok(fs.existsSync(file), `${name} exists`);
  const syntax = spawnSync('sh', ['-n', file], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `${name} must be valid POSIX sh: ${syntax.stderr}`);
  assert.notEqual(fs.statSync(file).mode & 0o111, 0, `${name} must be executable`);
}
const validator = path.join(deploy, 'validate-config.mjs');
assert.ok(fs.existsSync(validator), 'validate-config.mjs exists');
assert.equal(spawnSync(process.execPath, ['--check', validator], { encoding: 'utf8' }).status, 0);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-orchestrator-code-dev-'));
const fakeBin = path.join(temporary, 'bin');
const fakeDocker = path.join(fakeBin, 'docker');
const log = path.join(temporary, 'docker.log');
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(fakeDocker, `#!/bin/sh
{
  printf 'CALL\\n'
  for arg in "$@"; do printf '%s\\0' "$arg"; done
} >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect)
    case "\${FAKE_DOCKER_RUNNING:-true}" in
      true) printf 'true\\n' ;;
      false) printf 'false\\n' ;;
      missing) printf 'Error: No such object\\n' >&2; exit 1 ;;
    esac
    ;;
  exec)
    exit "\${FAKE_DOCKER_EXEC_STATUS:-0}"
    ;;
esac
exit 0
`, { mode: 0o755 });
fs.chmodSync(fakeDocker, 0o755);

function environment(overrides = {}) {
  return {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    ISSUE_ORCHESTRATOR_DOCKER: fakeDocker,
    ISSUE_ORCHESTRATOR_CONTAINER: 'code-dev',
    ISSUE_ORCHESTRATOR_CONTAINER_USER: 'dev',
    ISSUE_ORCHESTRATOR_CHECKOUT: '/projects/issue-orchestrator',
    ISSUE_ORCHESTRATOR_WORKSPACE: '/projects/issue-orchestrator-github-integration',
    ISSUE_ORCHESTRATOR_STATE_DIR: '/home/dev/.local/state/opencode/issue-orchestrator',
    ISSUE_ORCHESTRATOR_CONFIG: '/home/dev/.local/state/opencode/issue-orchestrator/config.jsonc',
    ISSUE_ORCHESTRATOR_START_TIMEOUT_SECONDS: '0',
    ISSUE_ORCHESTRATOR_STOP_TIMEOUT_SECONDS: '1',
    FAKE_DOCKER_LOG: log,
    ...overrides,
  };
}

function run(name, overrides = {}) {
  return spawnSync('sh', [path.join(deploy, name)], {
    cwd: root,
    encoding: 'utf8',
    env: environment(overrides),
  });
}

function calls() {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('CALL\n').filter(Boolean)
    .map((block) => {
      const args = block.split('\0');
      if (args.at(-1) === '') args.pop();
      return args;
    });
}

function resetLog() {
  fs.rmSync(log, { force: true });
}

function procStat(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = text.replace(/^[0-9]+ \(.*\) /, '').trim().split(/\s+/);
  return { state: fields[0], pgrp: fields[2], session: fields[3], starttime: fields[19] };
}

function pidFileFor(pid) {
  const file = path.join(temporary, `router-${pid}.pid`);
  fs.writeFileSync(file, `${pid} ${procStat(pid).starttime}\n`, { mode: 0o600 });
  return file;
}

function stopContainer(pidfile, timeout, worker, entrypoint, env = {}) {
  return spawnSync('sh', [path.join(deploy, 'stop-container.sh'), pidfile, String(timeout), worker, entrypoint], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  // Preflight waits for the running container and validates inside it as dev.
  let result = run('preflight.sh');
  assert.equal(result.status, 0, result.stderr);
  let recorded = calls();
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded[0], ['inspect', '--format', '{{.State.Running}}', 'code-dev']);
  assert.equal(recorded[1].slice(0, 3).join(' '), 'exec --user dev');
  assert.ok(recorded[1].includes('--workdir'));
  assert.ok(recorded[1].includes('/projects/issue-orchestrator'));
  assert.ok(recorded[1].includes('ISSUE_ORCHESTRATOR_HOME=/home/dev/.local/state/opencode/issue-orchestrator'));
  assert.ok(recorded[1].includes('ISSUE_ORCHESTRATOR_CONFIG=/home/dev/.local/state/opencode/issue-orchestrator/config.jsonc'));
  assert.ok(recorded[1].includes('ISSUE_ORCHESTRATOR_REPO=/projects/issue-orchestrator-github-integration'));
  assert.ok(recorded[1].includes('ISSUE_ORCHESTRATOR_MODE=router'));
  assert.ok(recorded[1].includes('ISSUE_ORCHESTRATOR_PID_FILE=/home/dev/.local/state/opencode/issue-orchestrator/router.pid'));
  assert.ok(recorded[1].includes('ISSUE_ORCHESTRATOR_LEGACY_HOME=/home/dev/.config/issue-orchestrator'));
  assert.ok(recorded[1].includes('ISSUE_ORCHESTRATOR_STATE_DECISION='));
  assert.ok(recorded[1].includes('GH_CONFIG_DIR=/home/dev/.config/gh'));
  assert.ok(recorded[1].includes('OPENCODE_CONFIG=/home/dev/.config/opencode/opencode.jsonc'));
  assert.ok(recorded[1].includes('XDG_DATA_HOME=/home/dev/.local/share'));
  assert.ok(recorded[1].includes('/bin/sh'));
  assert.ok(recorded[1].includes('/projects/issue-orchestrator/deploy/code-dev/check.sh'));

  // A stopped or missing container fails closed and is never started.
  for (const state of ['false', 'missing']) {
    resetLog();
    result = run('preflight.sh', { FAKE_DOCKER_RUNNING: state });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /never starts, restarts, or recreates/);
    assert.deepEqual(calls().map((call) => call[0]), ['inspect']);
  }

  // Unsafe deployment values fail before any Docker command.
  for (const overrides of [
    { ISSUE_ORCHESTRATOR_STATE_DIR: 'relative/state' },
    { ISSUE_ORCHESTRATOR_WORKSPACE: '' },
    { ISSUE_ORCHESTRATOR_CONFIG: 'relative.jsonc' },
    { ISSUE_ORCHESTRATOR_INTERVAL_SECONDS: '59x' },
    { ISSUE_ORCHESTRATOR_INTERVAL_SECONDS: '59' },
    { ISSUE_ORCHESTRATOR_MAX: '0' },
    { ISSUE_ORCHESTRATOR_MAX: '1001' },
    { ISSUE_ORCHESTRATOR_STOP_TIMEOUT_SECONDS: 'ten' },
    { ISSUE_ORCHESTRATOR_STATE_DECISION: 'sometimes' },
  ]) {
    resetLog();
    result = run('preflight.sh', overrides);
    assert.equal(result.status, 64, `${JSON.stringify(overrides)} must fail with 64: ${result.stderr}`);
    assert.deepEqual(calls(), [], 'invalid deployment values must not reach docker');
  }

  // A non-root-owned or group-readable env file must not be sourced as root.
  const unsafeEnv = path.join(temporary, 'unsafe.env');
  fs.writeFileSync(unsafeEnv, 'ISSUE_ORCHESTRATOR_CONTAINER=from-env-file\n', { mode: 0o644 });
  resetLog();
  result = run('preflight.sh', { ISSUE_ORCHESTRATOR_ENV_FILE: unsafeEnv });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /root-owned|mode 0600/);
  assert.deepEqual(calls(), []);
  fs.chmodSync(unsafeEnv, 0o600);
  resetLog();
  result = run('preflight.sh', { ISSUE_ORCHESTRATOR_ENV_FILE: unsafeEnv });
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls()[0].includes('from-env-file'));
  } else {
    assert.equal(result.status, 78);
    assert.match(result.stderr, /root-owned/);
    assert.deepEqual(calls(), []);
  }

  // The systemd unit's own env file is checked independently of manual
  // invocation and never sourced unless root-owned and private.
  const unitEnv = path.join(temporary, 'unit.env');
  fs.writeFileSync(unitEnv, 'ISSUE_ORCHESTRATOR_CONTAINER=unit-file\n', { mode: 0o644 });
  resetLog();
  result = run('preflight.sh', { ISSUE_ORCHESTRATOR_UNIT_ENV_FILE: unitEnv });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /systemd environment file.*root-owned|systemd environment file.*mode 0600/);
  assert.deepEqual(calls(), []);

  // The systemd ExecStart wrapper only execs the in-container entrypoint.
  resetLog();
  result = run('run.sh');
  assert.equal(result.status, 0, result.stderr);
  recorded = calls();
  assert.equal(recorded.length, 1);
  assert.ok(recorded[0].includes('ISSUE_ORCHESTRATOR_MODE=router'));
  assert.ok(recorded[0].includes('/projects/issue-orchestrator/deploy/code-dev/container-entrypoint.sh'));

  // Stop delegates to the in-container stop script and never changes the
  // container lifecycle.
  resetLog();
  result = run('stop.sh');
  assert.equal(result.status, 0, result.stderr);
  recorded = calls();
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded[0], ['inspect', '--format', '{{.State.Running}}', 'code-dev']);
  assert.ok(recorded[1].includes('/bin/sh'));
  assert.ok(recorded[1].includes('/projects/issue-orchestrator/deploy/code-dev/stop-container.sh'));
  assert.ok(recorded[1].includes('/home/dev/.local/state/opencode/issue-orchestrator/router.pid'));
  assert.ok(recorded[1].includes('/projects/issue-orchestrator/docker/worker.sh'));
  assert.ok(recorded[1].includes('/projects/issue-orchestrator/deploy/code-dev/container-entrypoint.sh'));
  assert.ok(!recorded[1].some((arg) => arg.includes('kill -KILL')));

  resetLog();
  result = run('stop.sh', { FAKE_DOCKER_RUNNING: 'false' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls().map((call) => call[0]), ['inspect']);

  // A missing stop script or a failed in-container stop is not swallowed.
  resetLog();
  result = run('stop.sh', { FAKE_DOCKER_EXEC_STATUS: '1' });
  assert.equal(result.status, 1);
  assert.equal(calls().length, 2);

  // State bootstrap is idempotent and non-destructive: it only creates the
  // durable directory and copies an absent config; it never copies or deletes
  // the live SQLite database.
  resetLog();
  result = run('init-state.sh');
  assert.equal(result.status, 0, result.stderr);
  recorded = calls();
  assert.equal(recorded.length, 2);
  const initScript = recorded[1].find((arg) => arg.includes('state=$1'));
  assert.ok(initScript);
  assert.match(initScript, /mkdir -m 700/);
  assert.match(initScript, /cp -p/);
  assert.doesNotMatch(initScript, /\brm\s+-/);
  assert.doesNotMatch(initScript, /cp .*orchestrator\.sqlite3/);
  assert.ok(recorded[1].includes('/home/dev/.local/state/opencode/issue-orchestrator'));
  assert.ok(recorded[1].includes('/home/dev/.config/issue-orchestrator/config.jsonc'));

  // In-container entrypoint: flock, durable PID+starttime, cmdline marker and
  // a dedicated session. It must not claim detached agent groups are covered.
  const entrypoint = fs.readFileSync(path.join(deploy, 'container-entrypoint.sh'), 'utf8');
  assert.match(entrypoint, /flock -n 9/);
  assert.match(entrypoint, /setsid --wait/);
  assert.match(entrypoint, /router\.pid/);
  assert.match(entrypoint, /issue-orchestrator-code-dev-session/);
  assert.match(entrypoint, /printf "%s %s\\n" "\$\$" "\$starttime"/);
  assert.doesNotMatch(entrypoint, /every agent\/OpenCode descendant|whole process tree/);
  assert.match(entrypoint, /exec "\$@"/);
  assert.doesNotMatch(entrypoint, /\bdocker\s+(?:exec|start|stop|restart|rm|compose)\b/);
  assert.doesNotMatch(entrypoint, /\brm\s+-rf\b/);

  // In-container preflight validates config through the public compiled
  // loader, enforces private state, migration decisions and provider auth.
  const check = fs.readFileSync(path.join(deploy, 'check.sh'), 'utf8');
  const validatorText = fs.readFileSync(validator, 'utf8');
  assert.match(check, /validate-config\.mjs/);
  assert.match(validatorText, /loadConfig/);
  assert.match(validatorText, /repoConfig/);
  assert.match(validatorText, /trusted_authors/);
  assert.match(validatorText, /tracker_account/);
  assert.match(validatorText, /agent_runner/);
  assert.match(check, /OpenCode provider auth export/);
  assert.match(validatorText, /auth export has no active credential/);
  assert.match(check, /ISSUE_ORCHESTRATOR_STATE_DECISION/);
  assert.match(check, /legacy SQLite state exists/);
  assert.match(check, /compiled CLI is older than deployment inputs/);
  assert.match(check, /workspace filesystem/);
  assert.match(validatorText, /statfsSync/);
  assert.match(validatorText, /dist\/core\/config\.js/);
  assert.match(check, /durable state directory/);
  assert.match(check, /overlayfs/);
  assert.match(check, /mode 0600 or 0400/);
  assert.match(check, /orchestrator\.sqlite3/);
  assert.match(check, /setsid/);
  assert.match(check, /flock/);
  assert.doesNotMatch(check, /\b(?:curl|wget)\b/);
  assert.doesNotMatch(check, /gh auth token|auth\.json.*cat|cat .*hosts\.yml/);

  // The standalone config validator checks the runtime requirements that the
  // JSONC schema does not: enabled account/trusted authors, workspace and
  // provider-auth provider.
  const fixtureWorkspace = path.join(temporary, 'workspace');
  fs.mkdirSync(path.join(fixtureWorkspace, '.git'), { recursive: true });
  const fixtureAuth = path.join(temporary, 'auth.json');
  fs.writeFileSync(fixtureAuth, JSON.stringify([{ integrationID: 'openai', active: true, value: { type: 'oauth' } }]), { mode: 0o600 });
  const baseConfig = {
    model: 'openai/gpt-6.1-sol',
    agent_runner: 'opencode',
    accounts: ['bot'],
    trusted_authors: ['alice'],
    repos: {
      'owner/repo': {
        enabled: true,
        account: 'bot',
        tracker: 'github',
        code_host: 'github',
        auto_merge: false,
        dod: {
          commands: { build: null, test: null, lint: null, typecheck: null, security: null },
          required_checks: ['CI'],
          evidence_class: 'docs',
          acceptance_source: 'issue_body',
        },
      },
    },
  };
  const fixtureConfig = path.join(temporary, 'config.jsonc');
  const validate = (overrides = {}) => spawnSync(process.execPath, [validator], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ISSUE_ORCHESTRATOR_CHECKOUT: root,
      ISSUE_ORCHESTRATOR_CONFIG: fixtureConfig,
      ISSUE_ORCHESTRATOR_REPO: fixtureWorkspace,
      ISSUE_ORCHESTRATOR_OPENCODE_AUTH: fixtureAuth,
      ...overrides,
    },
  });
  fs.writeFileSync(fixtureConfig, JSON.stringify(baseConfig, null, 2), { mode: 0o600 });
  let validation = validate();
  assert.equal(validation.status, 0, validation.stderr);
  fs.writeFileSync(fixtureConfig, JSON.stringify({ ...baseConfig, trusted_authors: [] }, null, 2), { mode: 0o600 });
  validation = validate();
  assert.equal(validation.status, 2);
  assert.match(validation.stderr, /trusted_authors/);
  fs.writeFileSync(fixtureConfig, JSON.stringify({ ...baseConfig, accounts: [], repos: { ...baseConfig.repos, 'owner/repo': { ...baseConfig.repos['owner/repo'], account: undefined } } }, null, 2), { mode: 0o600 });
  validation = validate();
  assert.equal(validation.status, 2);
  assert.match(validation.stderr, /account/);
  fs.writeFileSync(fixtureConfig, JSON.stringify(baseConfig, null, 2), { mode: 0o600 });
  fs.writeFileSync(fixtureAuth, JSON.stringify([{ integrationID: 'openai', active: false, value: { type: 'oauth' } }]), { mode: 0o600 });
  validation = validate();
  assert.equal(validation.status, 2);
  assert.match(validation.stderr, /no active credential for provider "openai"/);
  fs.writeFileSync(fixtureAuth, JSON.stringify([{ integrationID: 'openai', active: true, value: { type: 'oauth' } }]), { mode: 0o600 });
  validation = validate({ ISSUE_ORCHESTRATOR_REPO: path.join(temporary, 'missing-workspace') });
  assert.equal(validation.status, 2);
  assert.match(validation.stderr, /does not exist/);

  // The stop script verifies PID reuse, session identity and cmdline, removes
  // the pid file only after a clean stop, and never sends SIGKILL.
  const stop = fs.readFileSync(path.join(deploy, 'stop-container.sh'), 'utf8');
  assert.match(stop, /actual_start/);
  assert.match(stop, /start time mismatch/);
  assert.match(stop, /not the recorded router session leader/);
  assert.match(stop, /cmdline does not identify the router/);
  assert.match(stop, /refusing SIGKILL/);
  assert.match(stop, /rm -f "\$pidfile"/);
  assert.doesNotMatch(stop, /kill -KILL/, 'stop must not blindly SIGKILL detached agent groups');

  // Host scripts and unit never control the container lifecycle.
  const hostScripts = scripts
    .filter((name) => !['check.sh', 'container-entrypoint.sh', 'stop-container.sh'].includes(name))
    .map((name) => fs.readFileSync(path.join(deploy, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(hostScripts, /docker\s+(?:start|stop|restart|rm|kill)\b/);
  assert.doesNotMatch(hostScripts, /docker\s+compose\s+(?:up|down|stop|restart)\b/);
  assert.doesNotMatch(hostScripts, /\brm\s+-rf\b/);

  const unit = fs.readFileSync(path.join(systemd, 'issue-orchestrator-code-dev.service'), 'utf8');
  const section = (name) => unit.match(new RegExp(`(?:^|\\n)\\[${name}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`))?.[1] ?? '';
  const unitSection = section('Unit');
  const serviceSection = section('Service');
  assert.match(unitSection, /^Requires=docker\.service$/m);
  assert.match(unitSection, /^PartOf=docker\.service$/m);
  assert.match(unitSection, /^After=docker\.service network-online\.target$/m);
  assert.match(unitSection, /^StartLimitIntervalSec=1800$/m);
  assert.match(unitSection, /^StartLimitBurst=5$/m);
  assert.doesNotMatch(serviceSection, /^StartLimit/m, 'start-limit directives belong to [Unit]');
  assert.match(serviceSection, /^EnvironmentFile=-\/etc\/issue-orchestrator\/code-dev\.env$/m);
  assert.match(serviceSection, /^ExecStartPre=\/bin\/sh \/usr\/local\/lib\/issue-orchestrator\/preflight\.sh$/m);
  assert.match(serviceSection, /^ExecStart=\/bin\/sh \/usr\/local\/lib\/issue-orchestrator\/run\.sh$/m);
  assert.match(serviceSection, /^ExecStop=\/bin\/sh \/usr\/local\/lib\/issue-orchestrator\/stop\.sh$/m);
  assert.match(serviceSection, /^Restart=on-failure$/m);
  assert.match(serviceSection, /^RestartSec=60$/m);
  assert.match(serviceSection, /^TimeoutStartSec=300$/m);
  assert.match(serviceSection, /^TimeoutStopSec=330$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
  assert.doesNotMatch(unit, /Requires=code-dev|PartOf=code-dev|BindsTo=code-dev/);
  assert.doesNotMatch(unit, /ExecReload/);
  assert.doesNotMatch(unit, /docker\s+(?:start|stop|restart|rm|compose)\b/);
  assert.doesNotMatch(unit, /TOKEN|PASSWORD|SECRET|PRIVATE KEY/);

  // Syntax-verify a copy with environment-dependent dependencies removed.
  if (process.platform === 'linux') {
    const verifyUnit = unit
      .replace(/^Documentation=.*$/m, '')
      .replace(/^(?:Requires|PartOf|After|Wants)=.*$/gm, '')
      .replace(/^ExecStartPre=.*$/m, 'ExecStartPre=/bin/true')
      .replace(/^ExecStart=.*$/m, 'ExecStart=/bin/true')
      .replace(/^ExecStop=.*$/m, 'ExecStop=/bin/true');
    const verifyFile = path.join(temporary, 'issue-orchestrator-code-dev.service');
    fs.writeFileSync(verifyFile, verifyUnit);
    const verify = spawnSync('systemd-analyze', ['verify', verifyFile], { encoding: 'utf8' });
    if (verify.error?.code !== 'ENOENT') {
      assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    }
  }

  const envExample = fs.readFileSync(path.join(systemd, 'code-dev.env.example'), 'utf8');
  assert.match(envExample, /^ISSUE_ORCHESTRATOR_CONTAINER=code-dev$/m);
  assert.match(envExample, /^ISSUE_ORCHESTRATOR_CONTAINER_USER=dev$/m);
  assert.match(envExample, /^ISSUE_ORCHESTRATOR_CHECKOUT=\/projects\/issue-orchestrator$/m);
  assert.match(envExample, /^ISSUE_ORCHESTRATOR_STATE_DIR=\/home\/dev\/\.local\/state\/opencode\/issue-orchestrator$/m);
  assert.match(envExample, /^ISSUE_ORCHESTRATOR_CONFIG=\/home\/dev\/\.local\/state\/opencode\/issue-orchestrator\/config\.jsonc$/m);
  assert.match(envExample, /^ISSUE_ORCHESTRATOR_GH_CONFIG_DIR=\/home\/dev\/\.config\/gh$/m);
  assert.match(envExample, /^ISSUE_ORCHESTRATOR_OPENCODE_DATA_DIR=\/home\/dev\/\.local\/share\/opencode$/m);
  assert.match(envExample, /^# ISSUE_ORCHESTRATOR_STATE_DECISION=migrated$/m);
  assert.doesNotMatch(envExample, /TOKEN|PASSWORD|SECRET|BEGIN .*PRIVATE KEY/);

  // On Linux, exercise the real in-container stop logic with real sessions.
  // It verifies graceful stop, PID reuse, identity refusal and no SIGKILL.
  if (process.platform === 'linux') {
    const worker = path.join(temporary, 'fake-worker.sh');
    const quickly = path.join(temporary, 'fake-worker-ignore-term.sh');
    fs.writeFileSync(worker, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    fs.writeFileSync(quickly, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n", { mode: 0o755 });

    // Graceful stop: detached shell is a session leader and its cmdline
    // contains the fake worker path.
    const graceful = spawn('sh', [worker], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const gracefulPid = graceful.pid;
    const gracefulPidfile = pidFileFor(gracefulPid);
    result = stopContainer(gracefulPidfile, 5, worker, path.join(deploy, 'container-entrypoint.sh'));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(gracefulPidfile), false, 'successful stop removes the pid file');
    if (graceful.exitCode === null && graceful.signalCode === null) {
      await new Promise((resolve) => graceful.once('exit', resolve));
    }
    assert.equal(processAlive(gracefulPid), false, 'router process group stopped');

    // PID reuse: the recorded start time does not match, so the unrelated
    // process is never signalled; the stale pid file is removed.
    const reusePidfile = path.join(temporary, 'reuse.pid');
    fs.writeFileSync(reusePidfile, `${process.pid} 0\n`, { mode: 0o600 });
    result = stopContainer(reusePidfile, 1, worker, path.join(deploy, 'container-entrypoint.sh'));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /reused/);
    assert.equal(fs.existsSync(reusePidfile), false);
    assert.equal(processAlive(process.pid), true);

    // Identity mismatch: a live non-session-leader process is not signalled.
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mismatchPidfile = pidFileFor(other.pid);
    result = stopContainer(mismatchPidfile, 1, worker, path.join(deploy, 'container-entrypoint.sh'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not the recorded router session leader/);
    assert.equal(fs.existsSync(mismatchPidfile), true);
    assert.equal(processAlive(other.pid), true);
    other.kill('SIGKILL');
    if (other.exitCode === null && other.signalCode === null) {
      await new Promise((resolve) => other.once('exit', resolve));
    }
    fs.rmSync(mismatchPidfile, { force: true });

    // Missing pid file is a failure, not a false success.
    result = stopContainer(path.join(temporary, 'missing.pid'), 1, worker, path.join(deploy, 'container-entrypoint.sh'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pid file is missing/);

    // A TERM-ignoring session leader times out without SIGKILL; the process
    // stays alive, and the pid file is retained for inspection.
    const stubborn = spawn('sh', [quickly], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stubbornPid = stubborn.pid;
    const stubbornPidfile = pidFileFor(stubbornPid);
    result = stopContainer(stubbornPidfile, 1, quickly, path.join(deploy, 'container-entrypoint.sh'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing SIGKILL because detached agent sessions/);
    assert.equal(fs.existsSync(stubbornPidfile), true);
    assert.equal(processAlive(stubbornPid), true);
    try { process.kill(-stubbornPid, 'SIGKILL'); } catch { /* already gone */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(stubbornPidfile, { force: true });
  }

  // The compose deployment remains a separate, unchanged path.
  const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  assert.doesNotMatch(compose, /code-dev/);
  assert.doesNotMatch(compose, /docker\.sock|privileged:\s*true/);

  console.log('PASS code-dev docker-exec deployment, config validation, durable state and autostart contract');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
