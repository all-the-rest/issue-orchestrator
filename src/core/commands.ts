import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  configPath,
  loadConfig,
  repoConfig,
  enabledRepos,
  readState,
  writeState,
  readLock,
  acquireLock,
  writeLock,
  clearLock,
  lockPath,
  parseJsonc,
} from './config.js';
import { getProvider } from '../providers/index.js';
import { containsSecretLikeContent, publishEvidence, verifyOrigin } from '../evidence/index.js';

const CHECKPOINTS = new Set([
  'claimed', 'triaged', 'isolated', 'before-evidence', 'implemented',
  'change-pending', 'change-created', 'evidence-publishing', 'evidence-published',
  'reviewed', 'checks-green', 'merge-pending', 'merged', 'release-pending',
]);

const SEVERITY = {
  'severity:critical': 0,
  'severity:high': 1,
  'severity:medium': 2,
  'severity:low': 3,
  'severity:info': 4,
};

const HELP = `Usage: issue-orchestrator <command> [args] [--config <path>]

  status                          config, model, projects, lock (no writes)
  list [--project <p>] [--all-authors] [--limit <n>]
                                  open issues in queue order
  view <project> <issue>          issue body + comments, trusted flagged
  account <user> [--provider <p>] verify the active provider CLI account
  origin-check <project>           verify current Git remotes before pushing
  claim <project> <issue> [--branch <b>] [--owner-token <token>] [--force --confirm-stale]
                                  claim, or resume with this run's owner token
  resume-lock <project> <issue> --confirm-stale
                                  rotate ownership after verifying the old run stopped
  checkpoint <stage> --owner-token <token> [--branch <b>] [--change <n>] [--head <sha>] [--evidence <sha>]
                                  persist workflow progress for safe recovery
  release [--result done|blocked|review|needs-info|none] [--owner-token <token>] [--force --confirm-stale]
                                  drop the lock + outcome label
  label <project> <issue> add|remove <label>
  comment <project> <number> --body-file <f> [--kind issue|change]
  change-create <project> --head <b> --base <b> --title <t> --body-file <f> [--draft]
  checks <project> <number> [--watch] [--interval <s>]
  merge <project> <number> --owner-token <token>
                                  SHA-bound evidence/review/tests + required checks
  evidence <project> <issue> --dir <dir> --owner-token <token>
  ensure-labels [--project <p>]
  capture-model [--write]         read the global OpenCode model
  set-model <provider/model>      write model into the config
  help

Global: --config <path> isolates configuration/state; --json forces JSON output
for commands that print text by default. The active-work lock is
shared by all configs under the runtime home. The active provider CLI
identity must match the configured account; the agent never switches accounts
or extracts credentials.

Exit codes: 0 done/green, 1 refused/failed, 2 config missing/invalid, 8 checks pending.`;

class CliError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv: string[]): Record<string, any> {
  const opts: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

function requireConfig(opts) {
  try {
    return loadConfig(opts.config);
  } catch (error) {
    throw new CliError(error.message, 2);
  }
}

function configFile(opts) {
  return opts.config ?? configPath();
}

function assertEnabled(rc, project) {
  if (!rc.enabled) throw new CliError(`Project ${project} is disabled; refused`);
}

function context(cfg, project) {
  let rc;
  try {
    rc = repoConfig(cfg, project);
  } catch (error) {
    throw new CliError(error.message);
  }
  return { rc, provider: getProvider(rc.provider) };
}

function verifyAccount(provider, rc) {
  if (!rc.account) throw new CliError(`No account configured for ${rc.project}`);
  if (!provider.verifyAccount) throw new CliError(`Provider ${provider.name} cannot verify CLI account identity`);
  provider.verifyAccount(rc.account);
}

function bodyFromFile(file) {
  if (!file || file === true) throw new CliError('--body-file is required');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new CliError(`Body file not found: ${abs}`);
  const body = fs.readFileSync(abs, 'utf8');
  if (containsSecretLikeContent(body)) throw new CliError('Refusing to publish comment content that looks like a credential');
  return body;
}

function assertOwner(lock, opts, operation) {
  const token = opts['owner-token'];
  if (!token || token === true || token !== lock.owner_token) {
    throw new CliError(`${operation} requires this run's --owner-token; the queue lock is owned by another run`);
  }
}

function ownedLock(opts, { project, issue, change }: any = {}) {
  let lock;
  try {
    lock = readLock(lockPath(configFile(opts)));
  } catch (error) {
    throw new CliError(`Lock is corrupt: ${error.message}; inspect it before recovery`);
  }
  if (!lock) throw new CliError('No active queue lock; claim the issue before this operation');
  assertOwner(lock, opts, 'This operation');
  if (lock.config_file && path.resolve(lock.config_file) !== path.resolve(configFile(opts))) {
    throw new CliError(`active lock belongs to another config (${lock.config_file}); refusing cross-config access`);
  }
  if (project && lock.repo !== project) throw new CliError(`Active lock belongs to ${lock.repo}, not ${project}`);
  if (issue !== undefined && Number(lock.issue) !== Number(issue)) {
    throw new CliError(`Active lock belongs to issue #${lock.issue}, not #${issue}`);
  }
  if (change !== undefined && Number(lock.change_number) !== Number(change)) {
    throw new CliError(`Active lock belongs to change request #${lock.change_number ?? 'unset'}, not #${change}`);
  }
  return lock;
}

function saveCheckpoint(lock, stage, updates = {}, opts = {}) {
  if (!CHECKPOINTS.has(stage)) throw new CliError(`Unknown checkpoint "${stage}"`);
  const updatedAt = new Date().toISOString();
  const next = { ...lock, ...updates, stage, updated_at: updatedAt };
  writeLock(next, lockPath(configFile(opts)));
  const state = readState(configFile(opts));
  state.active = next;
  state.last_run = updatedAt;
  writeState(state, configFile(opts));
  return next;
}

function assertTrustedIssue(rc, issue) {
  if (issue.state && issue.state !== 'OPEN') {
    throw new CliError(`Issue #${issue.number ?? '?'} is not open; refused`);
  }
  const author = issue.author?.login ?? issue.author ?? null;
  if (!author || !rc.trusted_authors.includes(author)) {
    throw new CliError(`Issue #${issue.number ?? '?'} is not authored by a configured trusted author; refused`);
  }
}

function closesIssue(body, issue) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\s+#${Number(issue)}\\b`, 'i').test(body ?? '');
}

function containsSecretLikeFields(value) {
  if (typeof value === 'string') return containsSecretLikeContent(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSecretLikeFields);
  return Object.entries(value).some(([key, field]) => (
    containsSecretLikeContent(key) || containsSecretLikeFields(field)
  ));
}

function validSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function markerText(kind, head, issue, change, evidenceCommit = '') {
  const evidence = kind === 'evidence' ? ` commit=${evidenceCommit}` : '';
  return `<!-- git-issue-agent:${kind} head=${head} issue=${Number(issue)} pr=${Number(change)}${evidence} -->`;
}

function hasTrustedMarker(view, marker, authors) {
  return (view.comments ?? []).some((comment) =>
    authors.has(comment.author?.login) && (comment.body ?? '').includes(marker)
  );
}

function latestTrustedApproval(view, trustedAuthors, headSha) {
  const prAuthor = view.author?.login;
  const latestByAuthor = new Map();
  for (const review of view.reviews ?? []) {
    const login = review.author?.login;
    if (!login || login === prAuthor || !trustedAuthors.has(login) || !review.submittedAt) continue;
    const prior = latestByAuthor.get(login);
    if (!prior || Date.parse(review.submittedAt) > Date.parse(prior.submittedAt)) latestByAuthor.set(login, review);
  }
  const independentApproval = [...latestByAuthor.values()].some((review) => {
    const commit = typeof review.commit === 'string' ? review.commit : review.commit?.oid;
    return review.state === 'APPROVED' && typeof commit === 'string' && commit.toLowerCase() === headSha.toLowerCase();
  });
  return view.reviewDecision === 'APPROVED' && independentApproval;
}

function severityRank(labels) {
  let rank = 5;
  for (const label of labels) {
    if (label in SEVERITY) rank = Math.min(rank, SEVERITY[label]);
  }
  return rank;
}

function requirePositional(values, usage) {
  if (values.length === 0 || values.some((value) => !value || value === true)) {
    throw new CliError(`usage: ${usage}`);
  }
  return values;
}

function cmdStatus(opts) {
  const cfg = requireConfig(opts);
  const state = readState(configFile(opts));
  const projects = Object.keys(cfg.repos).map((project) => {
    const rc = repoConfig(cfg, project);
    return {
      project,
      provider: rc.provider,
      account: rc.account,
      enabled: rc.enabled,
      local_only: rc.local_only,
      auto_merge: rc.auto_merge,
      base_branch: rc.base_branch,
    };
  });
  const currentLock = readLock(lockPath(configFile(opts)));
  const publicLock = currentLock ? { ...currentLock, owner_token: undefined } : null;
  const activeState = state.active ? { ...state.active, owner_token: undefined } : null;
  console.log(JSON.stringify({
    config: cfg.__file,
    provider: cfg.provider ?? 'github',
    model: cfg.model ?? null,
    accounts: cfg.accounts ?? [],
    trusted_authors: cfg.trusted_authors ?? [],
    projects,
    lock: publicLock,
    active: activeState,
    last_run: state.last_run ?? null,
  }, null, 2));
  return 0;
}

function cmdList(opts) {
  const cfg = requireConfig(opts);
  const onlyTrusted = !opts['all-authors'];
  const projects = opts.project ? [String(opts.project)] : enabledRepos(cfg);
  const issues = [];

  for (const project of projects) {
    const { rc, provider } = context(cfg, project);
    if (!rc.enabled) continue;
    verifyAccount(provider, rc);
    const raw = provider.listIssues({ project, limit: Number(opts.limit ?? 100) });
    const blocked = new Set(
      [rc.labels.working, rc.labels.done, rc.labels.blocked, rc.labels.review, rc.labels.needs_info]
        .filter(Boolean),
    );
    for (const item of raw) {
      const labels = (item.labels ?? []).map((label) => (
        typeof label === 'string' ? label : label.name
      ));
      if (labels.some((label) => blocked.has(label))) continue;
      const author = item.author?.login ?? item.author ?? null;
      if (containsSecretLikeContent(item.title ?? '')) {
        throw new CliError(`Issue #${item.number} title looks like it contains a credential; discovery refused`);
      }
      const trusted = rc.trusted_authors.includes(author);
      if (onlyTrusted && !trusted) continue;
      issues.push({
        project,
        provider: rc.provider,
        number: item.number,
        title: item.title,
        author,
        trusted,
        labels,
        createdAt: item.createdAt ?? null,
        updatedAt: item.updatedAt ?? null,
        url: item.url ?? null,
      });
    }
  }

  issues.sort((a, b) => (
    severityRank(a.labels) - severityRank(b.labels) ||
    (Date.parse(a.createdAt ?? 0) - Date.parse(b.createdAt ?? 0))
  ));
  console.log(JSON.stringify(issues, null, 2));
  return 0;
}

function cmdView(opts) {
  const cfg = requireConfig(opts);
  const [project, number] = requirePositional(opts._.slice(0, 2), 'view <project> <issue>');
  const { rc, provider } = context(cfg, project);
  assertEnabled(rc, project);
  verifyAccount(provider, rc);
  const issue = provider.viewIssue({ project, number: Number(number) });
  assertTrustedIssue(rc, issue);
  if (containsSecretLikeFields(issue)) {
    throw new CliError(`Issue #${number} contains credential-like content; refusing to expose it to the model`);
  }
  const trusted = new Set(rc.trusted_authors);
  const comments = (issue.comments ?? []).map((comment) => ({
    ...comment,
    trusted: trusted.has(comment.author?.login),
  }));
  console.log(JSON.stringify({
    ...issue,
    comments,
    trusted_comments: comments.filter((comment) => comment.trusted),
  }, null, 2));
  return 0;
}

function cmdAccount(opts) {
  const cfg = requireConfig(opts);
  const [user] = requirePositional(opts._, 'account <user> [--provider <p>]');
  if (!(cfg.accounts ?? []).includes(user)) throw new CliError(`account "${user}" is not listed in config.accounts`);
  const provider = getProvider(opts.provider ?? cfg.provider ?? 'github');
  if (!provider.verifyAccount) throw new CliError(`Provider ${provider.name} cannot verify CLI account identity`);
  provider.verifyAccount(user);
  console.log(JSON.stringify({ provider: provider.name, account: user }, null, 2));
  return 0;
}

function cmdOriginCheck(opts) {
  const cfg = requireConfig(opts);
  const [project] = requirePositional(opts._, 'origin-check <project>');
  const { rc, provider } = context(cfg, project);
  assertEnabled(rc, project);
  if (rc.provider !== 'github') throw new CliError(`origin-check is not implemented for ${rc.provider}`);
  verifyAccount(provider, rc);
  const result = verifyOrigin(project);
  console.log(JSON.stringify({ project, verified: true, remote: result.remote, push_url: result.pushUrl }, null, 2));
  return 0;
}

function cmdClaim(opts) {
  const cfg = requireConfig(opts);
  const [project, issue] = requirePositional(
    opts._.slice(0, 2),
    'claim <project> <issue> [--branch <b>] [--owner-token <token>] [--force]',
  );
  const { rc, provider } = context(cfg, project);
  assertEnabled(rc, project);
  if (opts.force && !opts['confirm-stale']) {
    throw new CliError('claim --force requires --confirm-stale after verifying the previous run has stopped');
  }
  const number = Number(issue);
  if (!Number.isInteger(number) || number <= 0) throw new CliError(`Invalid issue number: ${issue}`);

  const lockFile = lockPath(configFile(opts));
  let previous = null;
  try {
    previous = readLock(lockFile);
  } catch (error) {
    if (!opts.force) throw new CliError(`Lock is corrupt: ${error.message}; release --force to clear`);
    fs.unlinkSync(lockFile);
  }
  verifyAccount(provider, rc);
  const issueData = provider.viewIssue({ project, number });
  assertTrustedIssue(rc, issueData);

  const sameClaim = previous && previous.repo === project && Number(previous.issue) === number;
  if (sameClaim && !opts.force && previous.config_file === path.resolve(configFile(opts)) &&
      opts['owner-token'] === previous.owner_token) {
    const updated = {
      ...previous,
      branch: opts.branch ?? previous.branch ?? null,
      local_only: rc.local_only,
      updated_at: new Date().toISOString(),
    };
    writeLock(updated, lockFile);
    const state = readState(configFile(opts));
    state.active = updated;
    state.last_run = updated.updated_at;
    writeState(state, configFile(opts));
    if (rc.labels.working) provider.addLabel({ project, number, label: rc.labels.working });
    console.log(JSON.stringify(updated, null, 2));
    return 0;
  }

  if (previous && !opts.force) {
    throw new CliError(
      `Queue is locked by ${previous.repo}#${previous.issue} since ${previous.claimed_at}; ` +
      'a same-issue claim also requires the exact --owner-token. Use resume-lock only after verifying the old run stopped.'
    );
  }

  const now = new Date().toISOString();
  const lock = {
    provider: rc.provider,
    repo: project,
    issue: number,
    branch: opts.branch ?? null,
    account: rc.account,
    config_file: path.resolve(configFile(opts)),
    owner_token: randomUUID(),
    stage: 'claimed',
    claimed_at: now,
    updated_at: now,
    local_only: rc.local_only,
  };
  try {
    acquireLock(lock, { file: lockFile, force: !!opts.force });
  } catch (error) {
    throw new CliError(error.message);
  }

  const state = readState(configFile(opts));
  state.active = lock;
  state.last_run = now;
  writeState(state, configFile(opts));
  // Keep the owner lock if a tracker write fails; a retry with the same token
  // is idempotent and cannot be mistaken for an independent scheduler.
  if (rc.labels.working) provider.addLabel({ project, number, label: rc.labels.working });
  console.log(JSON.stringify(lock, null, 2));
  return 0;
}

function cmdResumeLock(opts) {
  const cfg = requireConfig(opts);
  const [project, issue] = requirePositional(opts._.slice(0, 2), 'resume-lock <project> <issue> --confirm-stale');
  if (!opts['confirm-stale']) throw new CliError('resume-lock requires --confirm-stale after verifying the previous run has stopped');
  const { rc, provider } = context(cfg, project);
  assertEnabled(rc, project);
  const number = Number(issue);
  if (!Number.isSafeInteger(number) || number <= 0) throw new CliError(`Invalid issue number: ${issue}`);
  const lockFile = lockPath(configFile(opts));
  const lock = readLock(lockFile);
  if (!lock || lock.repo !== project || Number(lock.issue) !== number) {
    throw new CliError(`No matching active lock for ${project}#${number}`);
  }
  if (lock.config_file && path.resolve(lock.config_file) !== path.resolve(configFile(opts))) {
    throw new CliError('active lock belongs to another config; resume refused');
  }
  verifyAccount(provider, rc);
  assertTrustedIssue(rc, provider.viewIssue({ project, number }));
  const resumed = {
    ...lock,
    owner_token: randomUUID(),
    account: rc.account,
    config_file: path.resolve(configFile(opts)),
    resumed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeLock(resumed, lockFile);
  const state = readState(configFile(opts));
  state.active = resumed;
  state.last_run = resumed.updated_at;
  writeState(state, configFile(opts));
  console.log(JSON.stringify(resumed, null, 2));
  return 0;
}

function cmdCheckpoint(opts) {
  const [stage] = requirePositional(opts._, 'checkpoint <stage> --owner-token <token>');
  const lock = ownedLock(opts);
  const updates: Record<string, any> = {};
  if (opts.branch !== undefined) {
    if (typeof opts.branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(opts.branch) || opts.branch.includes('..')) {
      throw new CliError('invalid --branch');
    }
    updates.branch = opts.branch;
  }
  if (opts.change !== undefined) {
    const change = Number(opts.change);
    if (!Number.isSafeInteger(change) || change <= 0) throw new CliError('invalid --change');
    updates.change_number = change;
  }
  if (opts.head !== undefined) {
    if (!validSha(opts.head)) throw new CliError('--head must be a full 40-character commit SHA');
    updates.head_sha = String(opts.head).toLowerCase();
  }
  if (opts.evidence !== undefined) {
    if (!validSha(opts.evidence)) throw new CliError('--evidence must be a full 40-character commit SHA');
    updates.evidence_commit = String(opts.evidence).toLowerCase();
  }
  const next = saveCheckpoint(lock, stage, updates, opts);
  console.log(JSON.stringify({ checkpoint: next.stage, active: { ...next, owner_token: undefined } }, null, 2));
  return 0;
}

function cmdRelease(opts) {
  const lockFile = lockPath(configFile(opts));
  let lock;
  try {
    lock = readLock(lockFile);
  } catch (error) {
    if (!opts.force) {
      throw new CliError(`Lock is corrupt: ${error.message}; release --force to clear`);
    }
    if (!opts['confirm-stale']) throw new CliError('release --force requires --confirm-stale before clearing a corrupt lock');
    fs.unlinkSync(lockFile);
    const state = readState(configFile(opts));
    state.active = null;
    state.last_run = new Date().toISOString();
    writeState(state, configFile(opts));
    console.log(JSON.stringify({ released: true, force: true, reason: 'corrupt lock cleared' }, null, 2));
    return 0;
  }

  if (!lock) {
    console.log(JSON.stringify({ released: false, reason: 'no active lock' }, null, 2));
    return 0;
  }
  if (opts.force && !opts['confirm-stale']) {
    throw new CliError('release --force requires --confirm-stale after verifying the owner has stopped');
  }

  let result = opts.result ?? lock.release_result ?? 'none';
  if (!['done', 'blocked', 'review', 'needs-info', 'none'].includes(result)) {
    throw new CliError('--result must be done, blocked, review, needs-info or none');
  }

  if (!opts.force) assertOwner(lock, opts, 'release');
  if (!opts.force) {
    if (lock.config_file && path.resolve(lock.config_file) !== path.resolve(configFile(opts))) {
      throw new CliError('active lock belongs to another config; release refused');
    }
    const cfg = requireConfig(opts);
    const { rc, provider } = context(cfg, lock.repo);
    if (!rc.enabled) {
      throw new CliError(`${lock.repo} is disabled; re-enable it before release, or use release --force to clear without tracker writes`);
    }
    lock = saveCheckpoint(lock, 'release-pending', { release_result: result }, opts);
    verifyAccount(provider, rc);
    if (rc.labels.working) provider.removeLabel({ project: lock.repo, number: lock.issue, label: rc.labels.working });
    const target = result === 'done'
      ? rc.labels.done
      : result === 'blocked'
        ? rc.labels.blocked
        : result === 'review'
          ? rc.labels.review
          : result === 'needs-info'
            ? rc.labels.needs_info
            : null;
    if (target) provider.addLabel({ project: lock.repo, number: lock.issue, label: target });
  }

  if (opts.force) fs.unlinkSync(lockFile);
  else clearLock(lockFile, lock.owner_token);
  const state = readState(configFile(opts));
  state.active = null;
  state.last_run = new Date().toISOString();
  writeState(state, configFile(opts));
  console.log(JSON.stringify({ released: true, result, lock: { ...lock, owner_token: undefined }, force: !!opts.force }, null, 2));
  return 0;
}

function cmdLabel(opts) {
  const cfg = requireConfig(opts);
  const [project, issue, action, ...labelParts] = opts._;
  if (!project || !issue || !['add', 'remove'].includes(action) || labelParts.length === 0) {
    throw new CliError('usage: label <project> <issue> add|remove <label>');
  }
  const { rc, provider } = context(cfg, project);
  assertEnabled(rc, project);
  ownedLock(opts, { project, issue: Number(issue) });
  verifyAccount(provider, rc);
  const label = labelParts.join(' ');
  if (action === 'add') provider.addLabel({ project, number: Number(issue), label });
  else provider.removeLabel({ project, number: Number(issue), label });
  console.log(JSON.stringify({ project, issue: Number(issue), action, label }, null, 2));
  return 0;
}

function cmdComment(opts) {
  const cfg = requireConfig(opts);
  const [project, number] = requirePositional(
    opts._.slice(0, 2),
    'comment <project> <number> --body-file <f> [--kind issue|change]',
  );
  const kind = opts.kind ?? 'issue';
  if (!['issue', 'change'].includes(kind)) throw new CliError('--kind must be issue or change');
  const body = bodyFromFile(opts['body-file']);
  const { rc, provider } = context(cfg, project);
  assertEnabled(rc, project);
  if (!Number.isSafeInteger(Number(number)) || Number(number) <= 0) throw new CliError('invalid issue/change number');
  if (kind === 'issue') ownedLock(opts, { project, issue: Number(number) });
  else ownedLock(opts, { project, change: Number(number) });
  verifyAccount(provider, rc);
  provider.comment({ project, number: Number(number), body, kind });
  console.log(JSON.stringify({ commented: true, project, number: Number(number), kind }, null, 2));
  return 0;
}

function cmdChangeCreate(opts) {
  const cfg = requireConfig(opts);
  const [project] = requirePositional(
    opts._.slice(0, 1),
    'change-create <project> --head <b> --base <b> --title <t> --body-file <f> [--draft]',
  );
  if (!opts.head || opts.head === true || !opts.base || opts.base === true ||
      !opts.title || opts.title === true || !opts['body-file'] || opts['body-file'] === true) {
    throw new CliError('change-create requires --head, --base, --title and --body-file');
  }
  if (containsSecretLikeContent(opts.title)) throw new CliError('Refusing a change-request title that looks like a credential');
  const body = bodyFromFile(opts['body-file']);
  const { rc, provider } = context(cfg, project);
  assertEnabled(rc, project);
  const lock = ownedLock(opts, { project });
  if (!lock.branch || String(opts.head) !== lock.branch) {
    throw new CliError(`--head must match the claimed branch ${lock.branch ?? '(not set)'}`);
  }
  if (String(opts.base) !== rc.base_branch) {
    throw new CliError(`--base must match configured base branch ${rc.base_branch}`);
  }
  if (!closesIssue(body, lock.issue)) throw new CliError(`change request body must contain Closes #${lock.issue}`);
  if (rc.provider !== 'github') throw new CliError(`change creation is not implemented for ${rc.provider}`);
  verifyOrigin(project);
  const branch = spawnSync('git', ['branch', '--show-current'], { encoding: 'utf8' });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  if (branch.status !== 0 || head.status !== 0 || dirty.status !== 0) throw new CliError('change-create must run inside the issue worktree');
  if (branch.stdout.trim() !== lock.branch) throw new CliError(`current branch is ${branch.stdout.trim() || '(detached)'}, expected ${lock.branch}`);
  if (dirty.stdout.trim()) throw new CliError('change-create refuses a dirty worktree; commit or remove uncommitted changes first');
  const headSha = head.stdout.trim();
  if (!validSha(headSha)) throw new CliError('could not determine the issue branch head SHA');
  const pushed = spawnSync('git', ['ls-remote', '--heads', 'origin', `refs/heads/${lock.branch}`], { encoding: 'utf8' });
  if (pushed.status !== 0) throw new CliError('could not verify the pushed issue branch on origin');
  const pushedSha = pushed.stdout.trim().split(/\s+/)[0];
  if (!validSha(pushedSha) || pushedSha !== headSha) {
    throw new CliError('origin branch SHA does not match the current worktree head; change request refused');
  }
  verifyAccount(provider, rc);
  saveCheckpoint(lock, 'change-pending', { branch: String(opts.head), head_sha: headSha }, opts);
  const result = provider.createChange({
    project,
    head: String(opts.head),
    base: String(opts.base),
    title: String(opts.title),
    bodyFile: path.resolve(String(opts['body-file'])),
    draft: !!opts.draft,
  });
  if (!Number.isSafeInteger(Number(result.number)) || Number(result.number) <= 0) {
    throw new CliError('provider did not return a change-request number; record the created request before retrying');
  }
  const updated = saveCheckpoint(lock, 'change-created', {
    change_number: Number(result.number),
    branch: String(opts.head),
    head_sha: headSha,
  }, opts);
  result.head = headSha;
  result.checkpoint = updated.stage;
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function cmdChecks(opts) {
  const cfg = requireConfig(opts);
  const [project, number] = requirePositional(
    opts._.slice(0, 2),
    'checks <project> <number> [--watch] [--interval <s>]',
  );
  const { rc, provider } = context(cfg, project);
  assertEnabled(rc, project);
  verifyAccount(provider, rc);
  const before = provider.viewChange({ project, number: Number(number) });
  if (!validSha(before.headRefOid)) throw new CliError('provider did not report a full current head SHA');
  const raw = provider.checks({
    project,
    number: Number(number),
    required: true,
    watch: !!opts.watch,
    interval: Number(opts.interval ?? 10),
  });
  const after = provider.viewChange({ project, number: Number(number) });
  const changedDuringChecks = after.headRefOid !== before.headRefOid;
  // A killed process or an undocumented status is never "green".
  const status = !changedDuringChecks && (raw === 0 || raw === 8) ? raw : 1;
  console.log(JSON.stringify({
    project,
    number: Number(number),
    head_sha: before.headRefOid,
    changed_during_checks: changedDuringChecks,
    status,
    green: status === 0,
    pending: status === 8,
  }, null, 2));
  return status;
}

function cmdMerge(opts) {
  const cfg = requireConfig(opts);
  const [project, number] = requirePositional(opts._.slice(0, 2), 'merge <project> <number>');
  const { rc, provider } = context(cfg, project);
  assertEnabled(rc, project);
  if (!rc.auto_merge) {
    throw new CliError(`auto_merge is false for ${project}; leave the change request for a human`);
  }
  verifyAccount(provider, rc);

  const changeNumber = Number(number);
  const lock = ownedLock(opts, { project, change: changeNumber });
  if (!['reviewed', 'checks-green', 'merge-pending'].includes(lock.stage)) {
    throw new CliError(`workflow checkpoint is ${lock.stage ?? 'unknown'}, expected reviewed; merge refused`);
  }
  if (!validSha(lock.head_sha) || !validSha(lock.evidence_commit)) {
    throw new CliError('lock has no SHA-bound review head or evidence commit; merge refused');
  }

  // Fail closed: a provider that does not report these fields is not evidence
  // that the change request is mergeable.
  const view = provider.viewChange({ project, number: changeNumber });
  const alreadyMerged = view.state === 'MERGED';
  if ((!alreadyMerged && view.state !== 'OPEN') || view.isDraft !== false) {
    throw new CliError(`change request is ${view.state}${view.isDraft ? ' (draft)' : ''}; merge refused`);
  }
  if (!validSha(view.headRefOid) || view.headRefOid !== lock.head_sha) {
    throw new CliError('change request head differs from the reviewed/checkpointed SHA; refresh evidence and review');
  }
  if (view.headRefName !== lock.branch || view.baseRefName !== rc.base_branch) {
    throw new CliError('change request branch/base does not match the active issue lock; merge refused');
  }
  if (!closesIssue(view.body, lock.issue)) {
    throw new CliError(`change request body does not close active issue #${lock.issue}; merge refused`);
  }
  if (!alreadyMerged && view.mergeable !== 'MERGEABLE') {
    throw new CliError(`change request is not mergeable (${view.mergeable ?? 'unknown'}); merge refused`);
  }
  // Allowlist, not denylist: an undocumented state never reaches `merge`.
  // UNSTABLE/HAS_HOOKS are safe here because required checks are enforced below.
  if (!alreadyMerged && !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(view.mergeStateStatus)) {
    throw new CliError(`merge state is ${view.mergeStateStatus ?? 'unknown'}; merge refused`);
  }

  const markerAuthors = new Set(rc.trusted_authors);
  if (rc.account) markerAuthors.add(rc.account);
  const reviewMarker = markerText('review-approved', lock.head_sha, lock.issue, changeNumber);
  const testsMarker = markerText('tests', lock.head_sha, lock.issue, changeNumber);
  const evidenceMarker = markerText('evidence', lock.head_sha, lock.issue, changeNumber, lock.evidence_commit);
  if (!hasTrustedMarker(view, reviewMarker, markerAuthors)) {
    throw new CliError('missing exact-head independent review marker by a trusted author; merge refused');
  }
  if (!latestTrustedApproval(view, new Set(rc.trusted_authors), lock.head_sha)) {
    throw new CliError('missing GitHub APPROVED review by a trusted reviewer other than the PR author on this exact head SHA');
  }
  if (!hasTrustedMarker(view, testsMarker, markerAuthors)) {
    throw new CliError('missing exact-head test marker by a trusted author; merge refused');
  }
  if (!hasTrustedMarker(view, evidenceMarker, markerAuthors)) {
    throw new CliError('missing exact-head evidence marker by a trusted author; merge refused');
  }
  provider.verifyEvidence({
    project,
    commit: lock.evidence_commit,
    issue: lock.issue,
    change: changeNumber,
    head: lock.head_sha,
  });

  const status = provider.checks({ project, number: changeNumber, required: true });
  if (status !== 0) {
    throw new CliError(
      status === 8
        ? 'required checks still pending; merge refused'
        : 'required checks are not green or unavailable; merge refused',
    );
  }
  const finalView = provider.viewChange({ project, number: changeNumber });
  const expectedState = alreadyMerged ? 'MERGED' : 'OPEN';
  if (finalView.headRefOid !== lock.head_sha || finalView.state !== expectedState || finalView.isDraft !== false ||
      finalView.headRefName !== lock.branch || finalView.baseRefName !== rc.base_branch ||
      !closesIssue(finalView.body, lock.issue) ||
      (!alreadyMerged && finalView.baseRefOid !== view.baseRefOid) ||
      (!alreadyMerged && finalView.mergeable !== 'MERGEABLE') ||
      (!alreadyMerged && !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(finalView.mergeStateStatus))) {
    throw new CliError('change request changed during final checks; merge refused');
  }
  if (!hasTrustedMarker(finalView, reviewMarker, markerAuthors) ||
      !latestTrustedApproval(finalView, new Set(rc.trusted_authors), lock.head_sha) ||
      !hasTrustedMarker(finalView, testsMarker, markerAuthors) ||
      !hasTrustedMarker(finalView, evidenceMarker, markerAuthors)) {
    throw new CliError('review, test or evidence authorization changed during final checks; merge refused');
  }

  if (alreadyMerged) {
    saveCheckpoint(lock, 'merged', {}, opts);
    console.log(JSON.stringify({ merged: true, already_merged: true, project, number: changeNumber, url: view.url ?? null }, null, 2));
    return 0;
  }

  saveCheckpoint(lock, 'merge-pending', {}, opts);
  const result = provider.merge({ project, number: changeNumber, method: rc.merge_method, headSha: lock.head_sha });
  saveCheckpoint(lock, 'merged', {}, opts);
  console.log(JSON.stringify({
    merged: true,
    project,
    number: changeNumber,
    url: view.url ?? null,
    ...result,
  }, null, 2));
  return 0;
}

function cmdEvidence(opts) {
  const cfg = requireConfig(opts);
  const [project, issue] = requirePositional(
    opts._.slice(0, 2),
    'evidence <project> <issue> --dir <dir>',
  );
  if (!opts.dir || opts.dir === true) throw new CliError('--dir is required');
  if (opts['allow-secret-like']) throw new CliError('--allow-secret-like was removed; redact evidence instead of bypassing secret checks');
  const { rc, provider } = context(cfg, project);
  assertEnabled(rc, project);
  const lock = ownedLock(opts, { project, issue: Number(issue) });
  if (!Number.isSafeInteger(Number(lock.change_number)) || Number(lock.change_number) <= 0) {
    throw new CliError('create the change request before publishing evidence');
  }
  verifyAccount(provider, rc);
  const view = provider.viewChange({ project, number: Number(lock.change_number) });
  if (view.state !== 'OPEN' || !validSha(view.headRefOid) || view.headRefName !== lock.branch ||
      view.baseRefName !== rc.base_branch || !closesIssue(view.body, lock.issue)) {
    throw new CliError('change request does not match the active issue/branch/base; evidence refused');
  }
  const localHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (localHead.status !== 0 || localHead.stdout.trim() !== view.headRefOid) {
    throw new CliError('local worktree head differs from the change request; evidence refused');
  }
  saveCheckpoint(lock, 'evidence-publishing', { head_sha: view.headRefOid }, opts);
  const result = publishEvidence({
    project,
    issue,
    change: lock.change_number,
    head: view.headRefOid,
    dir: String(opts.dir),
    branchPrefix: rc.evidence_branch_prefix,
    rawUrl: (args) => provider.rawUrl(args),
  });
  saveCheckpoint(lock, 'evidence-published', {
    head_sha: view.headRefOid,
    evidence_commit: result.commit,
  }, opts);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function cmdEnsureLabels(opts) {
  const cfg = requireConfig(opts);
  const projects = opts.project ? [String(opts.project)] : enabledRepos(cfg);
  const definitions = {
    working: { color: 'FBCA04', description: 'The issue agent is working on this' },
    review: { color: '1D76DB', description: 'Change request open, evidence/review pending' },
    done: { color: '0E8A16', description: 'Implemented and merged' },
    blocked: { color: 'B60205', description: 'Needs a human decision' },
    needs_info: { color: 'D876E3', description: 'Not actionable yet' },
  };

  const created = [];
  for (const project of projects) {
    const { rc, provider } = context(cfg, project);
    if (!rc.enabled) continue;
    verifyAccount(provider, rc);
    for (const [role, definition] of Object.entries(definitions)) {
      const name = rc.labels[role];
      if (!name) continue;
      provider.ensureLabel({ project, name, ...definition });
      created.push({ project, name, role });
      if (!opts.json) console.log(`${project}: ${name} (${role})`);
    }
  }
  if (opts.json) console.log(JSON.stringify({ ensured: created }, null, 2));
  return 0;
}

function cmdCaptureModel(opts) {
  const file = process.env.OPENCODE_CONFIG ||
    path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc');
  if (!fs.existsSync(file)) throw new CliError(`OpenCode config not found: ${file}`);
  const cfg = parseJsonc(fs.readFileSync(file, 'utf8'), file);
  const model = cfg.agents?.general?.model ?? cfg.agents?.explore?.model ?? cfg.model;
  if (!model) {
    throw new CliError(`No model in ${file} (agents.general.model, agents.explore.model or model)`);
  }
  if (opts.write) setModel(opts, model);
  console.log(opts.json ? JSON.stringify({ model }) : model);
  return 0;
}

function cmdSetModel(opts) {
  const [model] = requirePositional(opts._, 'set-model <provider/model>');
  setModel(opts, model);
  console.log(opts.json ? JSON.stringify({ model }) : model);
  return 0;
}

function setModel(opts, model) {
  if (typeof model !== 'string' || !/^[^\s/]+\/[^\s/]+$/.test(model)) {
    throw new CliError('model must be a provider/model string');
  }
  const file = opts.config ?? configPath();
  if (!fs.existsSync(file)) throw new CliError(`Config not found: ${file}`, 2);
  let text = fs.readFileSync(file, 'utf8');
  const pattern = /("model"\s*:\s*)"[^"]*"/;
  if (pattern.test(text)) {
    text = text.replace(pattern, `$1${JSON.stringify(model)}`);
  } else {
    text = text.replace('{', `{\n  "model": ${JSON.stringify(model)},`);
  }
  parseJsonc(text, file);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const mode = fs.statSync(file).mode & 0o777;
  try {
    fs.writeFileSync(temp, text, { mode, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed or absent */ }
  }
}

const COMMANDS = {
  status: cmdStatus,
  list: cmdList,
  view: cmdView,
  account: cmdAccount,
  'origin-check': cmdOriginCheck,
  claim: cmdClaim,
  'resume-lock': cmdResumeLock,
  checkpoint: cmdCheckpoint,
  release: cmdRelease,
  label: cmdLabel,
  comment: cmdComment,
  'change-create': cmdChangeCreate,
  checks: cmdChecks,
  merge: cmdMerge,
  evidence: cmdEvidence,
  'ensure-labels': cmdEnsureLabels,
  'capture-model': cmdCaptureModel,
  'set-model': cmdSetModel,
};

export { COMMANDS, HELP, CliError, parseArgs };
