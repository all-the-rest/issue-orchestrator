// Deployment-semantic validation for the existing code-dev deployment.
//
// The JSONC schema loader covers syntax and field types; this script adds the
// runtime requirements that tickets poll needs: enabled GitHub projects have
// an account and a trusted-author allowlist, workspaces are writable Git
// checkouts with free space, and the private provider-auth export contains an
// active credential for the configured model provider.
//
// It reads the config, auth export and filesystem only. It never contacts a
// provider, opens SQLite, or prints file contents/credential values.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = process.env.ISSUE_ORCHESTRATOR_CHECKOUT;
const config = process.env.ISSUE_ORCHESTRATOR_CONFIG;
const workspace = process.env.ISSUE_ORCHESTRATOR_REPO;
const authFile = process.env.ISSUE_ORCHESTRATOR_OPENCODE_AUTH;

function fail(message) {
  console.error(`config validation failed: ${message}`);
  process.exit(2);
}

for (const [name, value] of [
  ['ISSUE_ORCHESTRATOR_CHECKOUT', checkout],
  ['ISSUE_ORCHESTRATOR_CONFIG', config],
  ['ISSUE_ORCHESTRATOR_REPO', workspace],
  ['ISSUE_ORCHESTRATOR_OPENCODE_AUTH', authFile],
]) {
  if (!value || !path.isAbsolute(value)) fail(`${name} must be an absolute path`);
}

let loadConfig;
let repoConfig;
let repositoryDiscoverySettings;
try {
  ({ loadConfig, repoConfig, repositoryDiscoverySettings } = await import(
    pathToFileURL(path.join(checkout, 'dist/core/config.js')).href
  ));
} catch {
  fail('compiled config loader is unavailable (run pnpm build)');
}

let cfg;
try {
  cfg = loadConfig(config);
} catch (error) {
  fail(error.message);
}

function freeSpace(directory, label) {
  let free;
  try {
    free = fs.statfsSync(directory);
  } catch {
    fail(`cannot read free space for ${label}: ${directory}`);
  }
  const available = Number(free.bavail) * Number(free.bsize);
  if (available < 1024 * 1024 * 1024) {
    fail(`${label} has less than 1 GiB free`);
  }
}

function privateWritableDirectory(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail(`${label} does not exist: ${directory}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} is not a directory: ${directory}`);
  if ((stat.mode & 0o077) !== 0) fail(`${label} must be private (mode 0700): ${directory}`);
  try {
    fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    fail(`${label} is not writable: ${directory}`);
  }
  freeSpace(directory, label);
}

const projects = Object.keys(cfg.repos ?? {}).filter((project) => repoConfig(cfg, project).enabled);
const discovery = repositoryDiscoverySettings(cfg);
if (projects.length === 0 && !discovery) fail('no enabled repositories are configured');
// Discovery alone does not poll anything when the inherited default disables
// every discovered repository; that deployment would start and idle.
if (discovery && projects.length === 0 && cfg.defaults?.enabled === false) {
  fail('discovery is enabled but defaults.enabled is false, so no repository would be polled');
}

for (const project of projects) {
  const rc = repoConfig(cfg, project);
  if (rc.tracker !== 'github') fail(`enabled project ${project} must use the GitHub tracker`);
  if (typeof rc.tracker_account !== 'string' || !rc.tracker_account) {
    fail(`enabled project ${project} needs a configured GitHub account`);
  }
  if (!Array.isArray(rc.trusted_authors) || rc.trusted_authors.length === 0) {
    fail(`enabled project ${project} needs a non-empty trusted_authors allowlist`);
  }
  if (rc.agent_runner !== 'opencode') {
    fail(`enabled project ${project} requires agent_runner "opencode" for ticket sessions`);
  }
  const base = rc.workspace
    ? path.resolve(workspace, rc.workspace)
    : path.resolve(workspace);
  let stat;
  try {
    stat = fs.statSync(base);
  } catch {
    fail(`workspace for ${project} does not exist: ${base}`);
  }
  if (!stat.isDirectory() || !fs.existsSync(path.join(base, '.git'))) {
    fail(`workspace for ${project} is not a Git checkout: ${base}`);
  }
  freeSpace(base, `workspace filesystem for ${project}`);
}

if (discovery) {
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  if (!discovery.account || !accounts.includes(discovery.account)) {
    fail('discovery.account must name a configured account');
  }
  if (!Array.isArray(discovery.trusted_authors) || discovery.trusted_authors.length === 0) {
    fail('discovery needs a non-empty trusted_authors allowlist');
  }
  if (typeof discovery.workspace_root !== 'string' || !path.isAbsolute(discovery.workspace_root)) {
    fail('discovery.workspace_root must be an absolute path');
  }
  if (fs.existsSync(discovery.workspace_root)) {
    privateWritableDirectory(discovery.workspace_root, 'discovery workspace_root');
  } else {
    // The checkout is created lazily on first dispatch. Validate that the
    // nearest existing ancestor can hold it and has enough free space, without
    // creating anything during preflight.
    let parent = path.dirname(discovery.workspace_root);
    for (;;) {
      if (fs.existsSync(parent)) break;
      const next = path.dirname(parent);
      if (next === parent) fail(`discovery workspace_root has no existing parent: ${discovery.workspace_root}`);
      parent = next;
    }
    let stat;
    try {
      stat = fs.lstatSync(parent);
    } catch {
      fail(`discovery workspace_root parent is unavailable: ${parent}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`discovery workspace_root parent is not a directory: ${parent}`);
    }
    try {
      fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      fail(`discovery workspace_root parent is not writable: ${parent}`);
    }
    freeSpace(parent, 'discovery workspace_root parent');
  }
}

const provider = String(cfg.model).split('/')[0];
let auth;
try {
  auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
} catch {
  fail('OpenCode provider auth export is not valid JSON');
}
const active = Array.isArray(auth)
  ? auth.some((entry) => entry && entry.integrationID === provider && entry.active === true &&
      entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value))
  : Boolean(auth && typeof auth === 'object' && !Array.isArray(auth) &&
      Object.prototype.hasOwnProperty.call(auth, provider));
if (!active) fail(`OpenCode auth export has no active credential for provider "${provider}"`);
