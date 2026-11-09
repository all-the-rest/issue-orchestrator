import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  databasePath,
  getRuntimeStore,
  importLegacyState,
  quarantineCorruptLegacyLock as quarantineLegacyLock,
} from './persistence.js';

export const DOD_CATEGORIES = ['build', 'test', 'lint', 'typecheck', 'security'] as const;
export const EVIDENCE_CLASSES = ['ui', 'cli', 'docs'] as const;
export const ACCEPTANCE_SOURCES = ['issue_body', 'triage_comment'] as const;

export function configDir() {
  const home = process.env.ISSUE_ORCHESTRATOR_HOME ?? process.env.GIT_ISSUE_AGENT_HOME;
  return home
    ? path.resolve(home)
    : path.join(os.homedir(), '.config', 'issue-orchestrator');
}

export function configPath() {
  const config = process.env.ISSUE_ORCHESTRATOR_CONFIG ?? process.env.GIT_ISSUE_AGENT_CONFIG;
  return config
    ? path.resolve(config)
    : path.join(configDir(), 'config.jsonc');
}

// All configs share the SQLite queue database under the runtime home.
export function lockPath(_configFile?: string) {
  return databasePath();
}

// Position of the next non-whitespace, non-comment character, so a trailing
// comma is still recognized when a comment follows it.
function nextSignificant(text, start) {
  let j = start;
  while (j < text.length) {
    if (/\s/.test(text[j])) { j++; continue; }
    if (text[j] === '/' && text[j + 1] === '/') {
      j += 2;
      while (j < text.length && text[j] !== '\n') j++;
      continue;
    }
    if (text[j] === '/' && text[j + 1] === '*') {
      j += 2;
      while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
      j += 2;
      continue;
    }
    break;
  }
  return j;
}

// JSONC: // and /* */ comments, plus trailing commas, kept outside strings.
export function parseJsonc(text, source = 'config.jsonc') {
  let out = '';
  let inString = false;
  let escape = false;
  let line = false;
  let block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (line) {
      if (c === '\n') { line = false; out += c; }
      continue;
    }
    if (block) {
      if (c === '*' && n === '/') { block = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (c === ',') {
      const j = nextSignificant(text, i + 1);
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  try {
    return JSON.parse(out);
  } catch (error) {
    throw new Error(`${source}: ${error.message}`);
  }
}

export function readJsonc(file) {
  return parseJsonc(fs.readFileSync(file, 'utf8'), file);
}

export function loadConfig(file = configPath()) {
  if (!fs.existsSync(file)) {
    throw new Error(`Config not found: ${file} — run setup, then fill the reported fields`);
  }
  const cfg = readJsonc(file);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`${file}: config must be a JSON object`);
  }
  validateConfig(cfg, file);
  return { ...cfg, __file: file };
}

function requireType(value, type, name, file) {
  if (typeof value !== type) throw new Error(`${file}: "${name}" must be ${type}`);
}

function validateConfig(cfg, file) {
  const positiveInteger = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${file}: "${name}" must be a positive integer`);
  };
  if (cfg.max_concurrency !== undefined) positiveInteger(cfg.max_concurrency, 'max_concurrency');
  if (!cfg.repos || typeof cfg.repos !== 'object' || Array.isArray(cfg.repos) ||
      Object.keys(cfg.repos).length === 0) {
    throw new Error(`${file}: "repos" must be a non-empty object keyed by project id`);
  }
  if (typeof cfg.model !== 'string' || !/^[^\s/]+\/[^\s/]+$/.test(cfg.model)) {
    throw new Error(`${file}: "model" must be a provider/model string`);
  }
  const accounts = cfg.accounts ?? [];
  if (!Array.isArray(accounts) || accounts.some((account) => typeof account !== 'string' || !account)) {
    throw new Error(`${file}: "accounts" must be an array of non-empty account names`);
  }
  if (new Set(accounts).size !== accounts.length) throw new Error(`${file}: "accounts" must not contain duplicates`);
  const trusted = cfg.trusted_authors ?? [];
  if (!Array.isArray(trusted) || trusted.some((author) => typeof author !== 'string' || !author)) {
    throw new Error(`${file}: "trusted_authors" must be an array of non-empty usernames`);
  }
  if (new Set(trusted).size !== trusted.length) throw new Error(`${file}: "trusted_authors" must not contain duplicates`);

  const defaults: any = cfg.defaults ?? {};
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error(`${file}: "defaults" must be an object`);
  }
  for (const field of ['enabled', 'local_only', 'auto_merge']) {
    if (field in defaults) requireType(defaults[field], 'boolean', `defaults.${field}`, file);
  }
  for (const provider of [cfg.provider, defaults.provider, cfg.tracker, cfg.code_host,
    defaults.tracker, defaults.code_host].filter((value) => value !== undefined)) {
    if (!['github', 'gitlab', 'jira'].includes(provider)) throw new Error(`${file}: unsupported provider "${provider}"`);
  }
  for (const [field, labels] of [['defaults.labels', defaults.labels], ['labels', cfg.labels]]) {
    if (labels === undefined) continue;
    if (!labels || typeof labels !== 'object' || Array.isArray(labels) ||
        Object.values(labels).some((label) => typeof label !== 'string' || !label)) {
      throw new Error(`${file}: "${field}" must be an object of non-empty label names`);
    }
  }
  const method = cfg.merge?.method;
  if (method !== undefined && !['squash', 'merge', 'rebase'].includes(method)) {
    throw new Error(`${file}: "merge.method" must be squash, merge or rebase`);
  }
  const prefix = cfg.evidence?.branch_prefix;
  if (prefix !== undefined && (!/^[A-Za-z0-9._/-]+$/.test(prefix) || prefix.includes('..') || prefix.startsWith('/') || prefix.endsWith('/') || prefix.includes('//'))) {
    throw new Error(`${file}: "evidence.branch_prefix" contains unsafe branch characters`);
  }

  for (const [project, rawRepo] of Object.entries(cfg.repos)) {
    const repo: any = rawRepo;
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(project)) {
      throw new Error(`${file}: invalid project id "${project}"`);
    }
    if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
      throw new Error(`${file}: repo "${project}" must be an object`);
    }
    if (repo.max_concurrency !== undefined) {
      positiveInteger(repo.max_concurrency, `repos.${project}.max_concurrency`);
      if (repo.max_concurrency > (cfg.max_concurrency ?? 1)) throw new Error(`${file}: repos.${project}.max_concurrency cannot exceed max_concurrency`);
    }
    if (repo.resource_locks !== undefined && (!Array.isArray(repo.resource_locks) ||
        repo.resource_locks.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) ||
        new Set(repo.resource_locks).size !== repo.resource_locks.length)) {
      throw new Error(`${file}: repos.${project}.resource_locks must be an array of unique safe names`);
    }
    const enabled = repo.enabled ?? defaults.enabled ?? true;
    const localOnly = repo.local_only ?? defaults.local_only ?? false;
    const autoMerge = repo.auto_merge ?? defaults.auto_merge ?? false;
    for (const [name, value] of [['enabled', enabled], ['local_only', localOnly], ['auto_merge', autoMerge]]) {
      requireType(value, 'boolean', `repos.${project}.${name}`, file);
    }
    const account = repo.account ?? accounts[0] ?? null;
    if (enabled && (typeof account !== 'string' || !account)) {
      throw new Error(`${file}: enabled repo "${project}" needs an explicit account`);
    }
    if (account && !accounts.includes(account)) {
      throw new Error(`${file}: account "${account}" for "${project}" is not listed in accounts`);
    }
    for (const provider of [repo.provider, repo.tracker, repo.code_host].filter((value) => value !== undefined)) {
      if (!['github', 'gitlab', 'jira'].includes(provider)) {
        throw new Error(`${file}: unsupported provider "${provider}" for "${project}"`);
      }
    }
    if (repo.code_host_project !== undefined && (typeof repo.code_host_project !== 'string' ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.code_host_project))) {
      throw new Error(`${file}: repos.${project}.code_host_project must be an owner/repository id`);
    }
    for (const accountField of ['account', 'tracker_account', 'code_host_account']) {
      if (repo[accountField] !== undefined && (typeof repo[accountField] !== 'string' || !repo[accountField])) {
        throw new Error(`${file}: repos.${project}.${accountField} must be a non-empty account name`);
      }
      if (repo[accountField] && !accounts.includes(repo[accountField])) {
        throw new Error(`${file}: account "${repo[accountField]}" for "${project}" is not listed in accounts`);
      }
    }
    if (repo.trusted_authors !== undefined &&
        (!Array.isArray(repo.trusted_authors) || repo.trusted_authors.some((author) => typeof author !== 'string' || !author))) {
      throw new Error(`${file}: repos.${project}.trusted_authors must be an array of usernames`);
    }
    if (repo.labels !== undefined && (!repo.labels || typeof repo.labels !== 'object' || Array.isArray(repo.labels) ||
        Object.values(repo.labels).some((label) => typeof label !== 'string' || !label))) {
      throw new Error(`${file}: repos.${project}.labels must be an object of non-empty label names`);
    }
    if (repo.base_branch !== undefined && (typeof repo.base_branch !== 'string' || !repo.base_branch)) {
      throw new Error(`${file}: repos.${project}.base_branch must be a non-empty string`);
    }
    const dod = repo.dod;
    if (!dod || typeof dod !== 'object' || Array.isArray(dod)) {
      throw new Error(`${file}: repos.${project}.dod must be an object`);
    }
    const commands = dod.commands;
    if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
      throw new Error(`${file}: repos.${project}.dod.commands must be an object`);
    }
    for (const category of DOD_CATEGORIES) {
      if (!(category in commands)) {
        throw new Error(`${file}: repos.${project}.dod.commands.${category} must be present (argv array or null)`);
      }
      const argv = commands[category];
      if (argv !== null && (!Array.isArray(argv) || argv.length === 0 ||
          argv.some((part) => typeof part !== 'string' || !part || part.includes('\0')))) {
        throw new Error(`${file}: repos.${project}.dod.commands.${category} must be a non-empty argv array or null`);
      }
    }
    if (!Array.isArray(dod.required_checks) || dod.required_checks.length === 0 ||
        dod.required_checks.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error(`${file}: repos.${project}.dod.required_checks must be a non-empty array of check names`);
    }
    if (new Set(dod.required_checks).size !== dod.required_checks.length) {
      throw new Error(`${file}: repos.${project}.dod.required_checks must contain unique names`);
    }
    if (!EVIDENCE_CLASSES.includes(dod.evidence_class)) {
      throw new Error(`${file}: repos.${project}.dod.evidence_class must be ui, cli or docs`);
    }
    if (!ACCEPTANCE_SOURCES.includes(dod.acceptance_source)) {
      throw new Error(`${file}: repos.${project}.dod.acceptance_source must be issue_body or triage_comment`);
    }
    if (dod.timeout_ms !== undefined && (!Number.isSafeInteger(dod.timeout_ms) || dod.timeout_ms < 1 || dod.timeout_ms > 3_600_000)) {
      throw new Error(`${file}: repos.${project}.dod.timeout_ms must be an integer from 1 to 3600000`);
    }
  }

  // Credentials belong in the host's credential store, never this config.
  const rejectCredentials = (value, at = '') => {
    if (typeof value === 'string') {
      if (/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/.test(value)) {
        throw new Error(`${file}: credential-like value at "${at.replace(/\.$/, '')}" is forbidden`);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/(?:token|secret|password|private.?key|api.?key|credential|authorization)/i.test(key)) {
        throw new Error(`${file}: credential-like field "${at}${key}" is forbidden; use the provider credential store`);
      }
      rejectCredentials(child, `${at}${key}.`);
    }
  };
  rejectCredentials(cfg);
}

export function repoConfig(cfg, project) {
  const own = cfg.repos?.[project];
  if (!own || typeof own !== 'object') {
    throw new Error(`Project "${project}" is not in ${cfg.__file ?? 'the config'}`);
  }
  const defaults = cfg.defaults ?? {};
  const labels = { ...(defaults.labels ?? {}), ...(own.labels ?? {}) };
  const enabled = own.enabled ?? defaults.enabled ?? true;
  const tracker = own.tracker ?? own.provider ?? defaults.tracker ?? cfg.tracker ??
    defaults.provider ?? cfg.provider ?? 'github';
  const codeHost = own.code_host ?? own.provider ?? defaults.code_host ?? cfg.code_host ??
    defaults.provider ?? cfg.provider ?? 'github';
  const account = own.account ?? cfg.accounts?.[0] ?? null;
  return {
    project,
    // Keep a stable persisted adapter identity so recovery refuses a changed
    // tracker/code-host pair without requiring a database migration.
    provider: tracker === codeHost ? tracker : `${tracker}+${codeHost}`,
    tracker,
    code_host: codeHost,
    code_host_project: own.code_host_project ?? project,
    account,
    tracker_account: own.tracker_account ?? account,
    code_host_account: own.code_host_account ?? account,
    enabled,
    local_only: own.local_only ?? defaults.local_only ?? false,
    auto_merge: enabled && (own.auto_merge ?? defaults.auto_merge ?? false),
    base_branch: own.base_branch ?? defaults.base_branch ?? 'main',
    trusted_authors: Array.isArray(own.trusted_authors)
      ? own.trusted_authors
      : (cfg.trusted_authors ?? []),
    labels,
    dod: own.dod,
    evidence_branch_prefix: own.evidence?.branch_prefix ?? cfg.evidence?.branch_prefix ?? 'agent-evidence',
    merge_method: own.merge_method ?? cfg.merge?.method ?? 'squash',
    raw: own,
  };
}

export function enabledRepos(cfg) {
  return Object.keys(cfg.repos).filter((project) => repoConfig(cfg, project).enabled);
}

export function readState(configFile) {
  const file = configFile ?? configPath();
  importLegacyState(file);
  return getRuntimeStore().readState(file);
}

export function readResumableLock(configFile: string, projectLimits?, requestedProject?: string) {
  importLegacyState(configFile);
  return getRuntimeStore().readResumableLock(configFile, projectLimits, requestedProject);
}

export function writeState(state, configFile) {
  getRuntimeStore().writeState(state, configFile ?? configPath());
}

export function readLock(_file = lockPath(), configFile?: string) {
  if (configFile) importLegacyState(configFile);
  return getRuntimeStore().readLock();
}

export function readLockByOwner(ownerToken: string) {
  return getRuntimeStore().readLockByOwner(ownerToken);
}

export function readLockForWorkItem(project: string, issue: string | number) {
  return getRuntimeStore().readLockForWorkItem(project, issue);
}

export function activeJobCount() {
  return getRuntimeStore().activeJobCount();
}

export function ownerProcessIdForOwner(ownerToken: string) {
  return getRuntimeStore().ownerProcessIdForOwner(ownerToken);
}

export function hasReadyJob(project: string, issue: string | number, configFile: string) {
  return getRuntimeStore().hasReadyJob(project, issue, configFile);
}

export function acquireLock(lock, { force = false, expectedOwnerToken, limits }: { force?: boolean; expectedOwnerToken?: string; limits?: { maxConcurrency?: number; projectConcurrency?: number; resourceLocks?: string[] } } = {}) {
  return getRuntimeStore().acquireLock(lock, force, expectedOwnerToken, limits);
}

export function writeLock(lock, _file = lockPath()) {
  return getRuntimeStore().updateLock(lock);
}

export function resumeLock(previousToken, lock, limits?) {
  return getRuntimeStore().resumeLock(previousToken, lock, limits);
}

export function clearLock(_file = lockPath(), ownerToken, result = 'none') {
  return getRuntimeStore().clearLock(ownerToken, result);
}

export function withMutationGuard<T>(fn: () => T): T {
  return getRuntimeStore({ importLegacy: false }).withMutationGuard(fn);
}

export function quarantineCorruptLegacyLock(configFile: string) {
  return quarantineLegacyLock(configFile);
}
