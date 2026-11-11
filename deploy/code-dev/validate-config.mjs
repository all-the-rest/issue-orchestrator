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
try {
  ({ loadConfig, repoConfig } = await import(
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

const projects = Object.keys(cfg.repos).filter((project) => repoConfig(cfg, project).enabled);
if (projects.length === 0) fail('no enabled repositories are configured');

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
  const free = fs.statfsSync(base);
  const available = Number(free.bavail) * Number(free.bsize);
  if (available < 1024 * 1024 * 1024) {
    fail(`workspace filesystem for ${project} has less than 1 GiB free`);
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
