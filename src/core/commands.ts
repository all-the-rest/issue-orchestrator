import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
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
  resumeLock,
  clearLock,
  lockPath,
  quarantineCorruptLegacyLock,
  parseJsonc,
} from './config.js';
import { getProvider } from '../providers/index.js';
import {
  containsSecretLikeContent,
  publishEvidence,
  prepareEvidenceManifest,
  reconcileEvidenceBranch,
  verifyOrigin,
} from '../evidence/index.js';
import { getRuntimeStore } from './persistence.js';
import { runJournaledSideEffect, sideEffectKey, type SideEffectObservation } from './side-effects.js';

const CHECKPOINTS = new Set([
  'claimed', 'triaged', 'isolated', 'before-evidence', 'implemented',
  'change-pending', 'change-created', 'evidence-publishing', 'evidence-published',
  'reviewed', 'checks-green', 'merge-pending', 'merged', 'release-pending',
]);
const AGENT_CHECKPOINTS = new Set(['triaged', 'isolated', 'before-evidence', 'implemented', 'reviewed']);

const SEVERITY = {
  'severity:critical': 0,
  'severity:high': 1,
  'severity:medium': 2,
  'severity:low': 3,
  'severity:info': 4,
};

const HELP = `Usage: issue-orchestrator <command> [args] [--config <path>]

  status                          config, model, lock and recovery (may update tracker)
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
  release --result done|blocked|review|needs-info [--owner-token <token>]
                                  record a terminal outcome and drop the lock
  release --force --confirm-stale [--result none]
                                  explicit stale recovery (no tracker writes)
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
for commands that print text by default. The SQLite-backed active-work queue is
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
    lock = readLock(lockPath(configFile(opts)), configFile(opts));
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

function journaledWrite({ lock, kind, identity, intent, reconcile, apply }) {
  const store = getRuntimeStore();
  const ownerToken = lock?.owner_token;
  const idempotencyKey = sideEffectKey(store, ownerToken, kind, identity);
  return runJournaledSideEffect({
    store,
    ownerToken,
    idempotencyKey,
    kind,
    intent,
    reconcile,
    apply,
  });
}

function labelNames(issue) {
  if (!Array.isArray(issue?.labels)) return null;
  return issue.labels.map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean);
}

function observeIssueLabel(provider, project, issue, label, action): SideEffectObservation {
  const current = labelNames(provider.viewIssue({ project, number: issue }));
  if (!current) return { state: 'unknown', reason: 'tracker did not report issue labels' };
  const present = current.includes(label);
  return (action === 'add' ? present : !present)
    ? { state: 'applied', result: { project, issue, label, action, observed: true } }
    : { state: 'absent' };
}

function journalIssueLabel({ lock, provider, project, issue, label, action }) {
  return journaledWrite({
    lock,
    kind: `issue-label-${action}`,
    identity: { project, issue, label, action },
    intent: { project, issue, label, action },
    reconcile: () => observeIssueLabel(provider, project, issue, label, action),
    apply: () => action === 'add'
      ? provider.addLabel({ project, number: issue, label })
      : provider.removeLabel({ project, number: issue, label }),
  });
}

function finishRecoveredMergeLabels(store, effect, lock, opts) {
  const project = effect.project;
  const issue = Number(effect.issue);
  if (typeof project !== 'string' || !Number.isSafeInteger(issue) || issue <= 0 || !lock?.owner_token) {
    throw new CliError('recovered merge has no complete project, issue or recovery owner');
  }
  const cfg = loadConfig(effect.configFile ?? configFile(opts));
  const { rc, provider } = context(cfg, project);
  if (!rc.enabled) throw new CliError(`${project} is disabled; merge recovery will retain its lock until re-enabled`);
  if (rc.provider !== effect.provider) {
    throw new CliError(`provider changed from ${effect.provider} to ${rc.provider}; merge recovery labels were not finalized`);
  }
  verifyAccount(provider, rc);

  const requiredLabelKeys = [];
  if (rc.labels.working) {
    const identity = { project, issue, label: rc.labels.working, action: 'remove' };
    journalIssueLabel({ lock, provider, project, issue, label: rc.labels.working, action: 'remove' });
    requiredLabelKeys.push(sideEffectKey(store, lock.owner_token, 'issue-label-remove', identity));
  }
  if (rc.labels.done) {
    const identity = { project, issue, label: rc.labels.done, action: 'add' };
    journalIssueLabel({ lock, provider, project, issue, label: rc.labels.done, action: 'add' });
    requiredLabelKeys.push(sideEffectKey(store, lock.owner_token, 'issue-label-add', identity));
  }
  if (!store.finalizeMergedRecovery(lock.owner_token, effect.idempotencyKey, requiredLabelKeys)) {
    throw new CliError('merge recovery labels were not durably completed; ownership remains active for retry');
  }
  return true;
}

function observeComment(provider, project, number, kind, marker, expectedAuthor, expectedContentHash): SideEffectObservation {
  const view = kind === 'change'
    ? provider.viewChange({ project, number })
    : provider.viewIssue({ project, number });
  if (!Array.isArray(view?.comments)) return { state: 'unknown', reason: 'tracker did not report comments' };
  const marked = view.comments.filter((comment) => typeof comment?.body === 'string' && comment.body.includes(marker));
  if (marked.length === 0) return { state: 'absent' };
  if (marked.length !== 1 || !expectedAuthor || !/^[a-f0-9]{64}$/i.test(expectedContentHash ?? '')) {
    return { state: 'unknown', reason: 'comment marker is duplicated or its intended author/content is unavailable' };
  }
  const comment = marked[0];
  const author = comment.author?.login ?? comment.author;
  const contentHash = createHash('sha256').update(comment.body).digest('hex');
  if (typeof author !== 'string' || author.toLowerCase() !== expectedAuthor.toLowerCase() || contentHash !== expectedContentHash) {
    return { state: 'unknown', reason: 'comment marker exists but its author or exact rendered content does not match the journaled intent' };
  }
  return { state: 'applied', result: { project, number, kind, marker, author, content_sha256: contentHash } };
}

function journalComment({ lock, provider, project, number, kind, body, author }) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const content = `${body}${body.endsWith('\n') ? '' : '\n'}\n`;
  const identity = { project, number, kind, body_sha256: bodyHash, actor: author };
  const store = getRuntimeStore();
  const ownerToken = lock?.owner_token;
  const key = sideEffectKey(store, ownerToken, 'comment', identity);
  const marker = `<!-- issue-orchestrator:idempotency=${key} -->`;
  const renderedContent = `${content}${marker}`;
  const renderedHash = createHash('sha256').update(renderedContent).digest('hex');
  const intent = { ...identity, content_sha256: renderedHash };
  return runJournaledSideEffect({
    store,
    ownerToken,
    idempotencyKey: key,
    kind: 'comment',
    intent,
    reconcile: () => observeComment(provider, project, number, kind, marker, author, renderedHash),
    apply: () => provider.comment({ project, number, body: renderedContent, kind }),
  });
}

function observeRepoLabel(provider, project, name, expected): SideEffectObservation {
  if (typeof provider.getLabel !== 'function') {
    return { state: 'unknown', reason: `provider ${provider.name} cannot inspect repository labels` };
  }
  const current = provider.getLabel({ project, name });
  if (!current) return { state: 'absent' };
  const matches = String(current.color ?? '').replace(/^#/, '').toUpperCase() === String(expected.color).toUpperCase() &&
    current.description === expected.description;
  return matches
    ? { state: 'applied', result: { project, name, color: current.color, description: current.description } }
    : { state: 'absent' };
}

function inspectPendingSideEffect(effect, opts): SideEffectObservation {
  const intent = effect.intent as Record<string, any>;
  const project = effect.project ?? intent.project;
  if (typeof project !== 'string' || !project || typeof effect.provider !== 'string') {
    return { state: 'unknown', reason: 'journal entry has no resolvable project/provider' };
  }

  try {
    const cfg = loadConfig(effect.configFile ?? opts.config);
    const { rc, provider } = context(cfg, project);
    if (rc.provider !== effect.provider) {
      return { state: 'unknown', reason: `configured provider changed from ${effect.provider} to ${rc.provider}` };
    }
    verifyAccount(provider, rc);

    switch (effect.kind) {
      case 'issue-label-add':
      case 'issue-label-remove':
        if (!Number.isSafeInteger(Number(intent.issue)) || typeof intent.label !== 'string') {
          return { state: 'unknown', reason: 'issue-label intent is incomplete' };
        }
        return observeIssueLabel(
          provider, project, Number(intent.issue), intent.label,
          effect.kind === 'issue-label-add' ? 'add' : 'remove',
        );
      case 'comment': {
        if (!Number.isSafeInteger(Number(intent.number)) || !['issue', 'change'].includes(intent.kind) ||
            typeof intent.actor !== 'string' || intent.actor !== rc.account) {
          return { state: 'unknown', reason: 'comment intent has no trusted configured actor' };
        }
        const marker = `<!-- issue-orchestrator:idempotency=${effect.idempotencyKey} -->`;
        return observeComment(
          provider, project, Number(intent.number), intent.kind, marker,
          intent.actor, intent.content_sha256,
        );
      }
      case 'ensure-label':
        return observeRepoLabel(provider, project, intent.name, intent);
      case 'change-create': {
        if (typeof provider.findChange !== 'function' || typeof provider.viewChange !== 'function') {
          return { state: 'unknown', reason: `provider ${provider.name} cannot inspect change requests` };
        }
        const existing = provider.findChange({ project, head: intent.head, base: intent.base });
        if (!existing) return { state: 'absent' };
        const view = provider.viewChange({ project, number: Number(existing.number) });
        if (view.state !== 'OPEN' || view.headRefName !== intent.head || view.headRefOid !== intent.head_sha ||
            view.baseRefName !== intent.base || !closesIssue(view.body, intent.issue)) {
          return { state: 'unknown', reason: 'existing change request does not match the journaled issue, branch, base and head' };
        }
        return { state: 'applied', result: existing };
      }
      case 'merge': {
        if (typeof provider.viewChange !== 'function') {
          return { state: 'unknown', reason: `provider ${provider.name} cannot inspect change requests` };
        }
        if (!Number.isSafeInteger(Number(effect.issue)) || Number(effect.issue) <= 0 ||
            !Number.isSafeInteger(Number(effect.changeNumber)) || Number(effect.changeNumber) <= 0 ||
            !validSha(effect.headSha) || typeof effect.branch !== 'string' || !effect.branch) {
          return { state: 'unknown', reason: 'merge is not attached to a complete persisted job identity' };
        }
        const expectedIssue = Number(effect.issue);
        const expectedNumber = Number(effect.changeNumber);
        const expectedHead = effect.headSha.toLowerCase();
        if (Number(intent.number) !== expectedNumber || Number(intent.issue) !== expectedIssue ||
            intent.project !== project || intent.head_sha?.toLowerCase() !== expectedHead ||
            intent.branch !== effect.branch || intent.base !== rc.base_branch ||
            typeof intent.owner_token !== 'string' || !intent.owner_token) {
          return { state: 'unknown', reason: 'merge intent does not match the persisted issue, PR, branch, base, head and owner' };
        }
        const current = provider.viewChange({ project, number: Number(intent.number) });
        if (Number(current.number) !== expectedNumber || current.headRefOid?.toLowerCase() !== expectedHead ||
            current.headRefName !== effect.branch || current.baseRefName !== rc.base_branch ||
            !closesIssue(current.body, expectedIssue)) {
          return { state: 'unknown', reason: 'observed PR does not match the exact persisted job, issue, branch, base and head' };
        }
        const issue = provider.viewIssue({ project, number: expectedIssue });
        if (Number(issue.number) !== expectedIssue) {
          return { state: 'unknown', reason: 'provider returned a different linked issue during merge recovery' };
        }
        try {
          assertTrustedIssue(rc, issue, { allowClosed: true });
        } catch (error) {
          return { state: 'unknown', reason: `linked issue cannot be trusted for merge recovery: ${(error as Error).message}` };
        }
        const observed = {
          project,
          number: expectedNumber,
          head_sha: expectedHead,
          issue: expectedIssue,
          branch: effect.branch,
          base: rc.base_branch,
        };
        if (current.state === 'MERGED') return { state: 'applied', result: observed };
        if (current.state === 'OPEN') return { state: 'absent' };
        return { state: 'unknown', reason: `change request is ${current.state} or its head no longer matches` };
      }
      case 'evidence': {
        if (typeof provider.rawUrl !== 'function') {
          return { state: 'unknown', reason: `provider ${provider.name} cannot inspect remote evidence` };
        }
        if (!intent.expected_manifest || typeof intent.branch !== 'string') {
          return { state: 'unknown', reason: 'evidence intent lacks its locally expected manifest or scoped branch' };
        }
        const result = reconcileEvidenceBranch({
          project,
          issue: intent.issue,
          change: intent.change,
          head: intent.head,
          branch: intent.branch,
          expectedManifest: intent.expected_manifest,
          rawUrl: (args) => provider.rawUrl(args),
        });
        return result ? { state: 'applied', result } : { state: 'absent' };
      }
      default:
        return { state: 'unknown', reason: `no startup inspector for side effect kind ${effect.kind}` };
    }
  } catch (error) {
    return { state: 'unknown', reason: (error as Error).message };
  }
}

function reconcilePendingSideEffects(opts) {
  // Preserve command-specific legacy-lock recovery (notably corrupt-lock quarantine).
  const store = getRuntimeStore({ importLegacy: false });
  const reapedLeases = store.reapExpiredLeases();
  const inspected = [];
  for (const effect of store.pendingSideEffects()) {
    const observation = inspectPendingSideEffect(effect, opts);
    if (observation.state === 'applied') {
      if (effect.kind === 'merge') {
        const recoveryLock = store.prepareMergedSideEffectRecovery(effect.idempotencyKey, observation.result as {
          project: string; number: number; head_sha: string; issue: number; branch: string; base: string;
        });
        const recovered = recoveryLock ? finishRecoveredMergeLabels(store, effect, recoveryLock, opts) : false;
        if (!recovered) {
          store.markSideEffectUncertain(effect.idempotencyKey, 'verified merge belongs to a job with a different active owner; refusing recovery');
        }
        inspected.push({
          idempotency_key: effect.idempotencyKey,
          kind: effect.kind,
          project: effect.project,
          observation: recovered ? 'applied' : 'unknown',
          reason: recovered ? undefined : 'verified merge belongs to a job with a different active owner; refusing recovery',
        });
        continue;
      }
      store.completeSideEffect(effect.idempotencyKey, { outcome: 'startup-reconciled', observed: observation.result });
    } else if (observation.state === 'unknown') {
      store.markSideEffectUncertain(effect.idempotencyKey, observation.reason);
    } else {
      store.markSideEffectPending(effect.idempotencyKey);
    }
    inspected.push({
      idempotency_key: effect.idempotencyKey,
      kind: effect.kind,
      project: effect.project,
      observation: observation.state,
      reason: observation.state === 'unknown' ? observation.reason : undefined,
    });
  }
  for (const effect of store.completedMergeRecoveries()) {
    const observation = inspectPendingSideEffect(effect, opts);
    let recovered = false;
    if (observation.state === 'applied') {
      const recoveryLock = store.prepareMergedSideEffectRecovery(effect.idempotencyKey, observation.result as {
        project: string; number: number; head_sha: string; issue: number; branch: string; base: string;
      });
      recovered = recoveryLock ? finishRecoveredMergeLabels(store, effect, recoveryLock, opts) : false;
    }
    inspected.push({
      idempotency_key: effect.idempotencyKey,
      kind: effect.kind,
      project: effect.project,
      observation: recovered ? 'applied' : 'unknown',
      reason: recovered ? undefined : observation.state === 'unknown'
        ? observation.reason
        : 'completed merge journal could not safely finalize workflow and queue state',
    });
  }
  return {
    leases_reaped: reapedLeases.length,
    inspected: inspected.length,
    completed: inspected.filter((item) => item.observation === 'applied').length,
    absent: inspected.filter((item) => item.observation === 'absent').length,
    uncertain: inspected.filter((item) => item.observation === 'unknown').length,
    entries: inspected,
  };
}

function advanceCheckpointWorkflow(lock, stage) {
  const store = getRuntimeStore();
  const actor = 'agent';
  const advance = (state, reason = `agent checkpoint: ${stage}`) => {
    if (store.workflowStateForOwner(lock.owner_token) === state) return false;
    return store.transitionWorkflow(lock.owner_token, state, actor, reason);
  };
  switch (stage) {
    case 'triaged': return advance('TRIAGED');
    case 'isolated': return advance('ISOLATED');
    case 'before-evidence': return advance('BEFORE_CAPTURED');
    case 'implemented':
      if (store.workflowStateForOwner(lock.owner_token) === 'IMPLEMENTED') return false;
      if (store.workflowStateForOwner(lock.owner_token) === 'IMPLEMENTING') {
        return advance('IMPLEMENTED', 'agent implementation completed');
      }
      advance('IMPLEMENTING', 'agent started implementation');
      return advance('IMPLEMENTED', 'agent implementation completed');
    case 'reviewed':
      return advance('REVIEWING', 'agent submitted review for external approval');
    default:
      return false;
  }
}

function assertTrustedIssue(rc, issue, { allowClosed = false } = {}) {
  if (!allowClosed && issue.state && issue.state !== 'OPEN') {
    throw new CliError(`Issue #${issue.number ?? '?'} is not open; refused`);
  }
  if (allowClosed && issue.state && !['OPEN', 'CLOSED'].includes(issue.state)) {
    throw new CliError(`Issue #${issue.number ?? '?'} has an unknown state; refused`);
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
  const currentLock = readLock(lockPath(configFile(opts)), configFile(opts));
  const publicLock = currentLock ? { ...currentLock, owner_token: undefined } : null;
  const activeState = state.active ? { ...state.active, owner_token: undefined } : null;
  const pendingSideEffects = getRuntimeStore().pendingSideEffects().map((effect) => ({
    idempotency_key: effect.idempotencyKey,
    kind: effect.kind,
    project: effect.project,
    status: effect.status,
    reason: effect.status === 'UNCERTAIN' ? effect.result?.reason ?? 'external state is uncertain' : undefined,
  }));
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
    side_effect_reconciliation: opts.reconciliation ?? null,
    pending_side_effects: pendingSideEffects,
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
  const previous = readLock(lockFile, configFile(opts));
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
    if (rc.labels.working) journalIssueLabel({
      lock: updated, provider, project, issue: number, label: rc.labels.working, action: 'add',
    });
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
    acquireLock(lock, { force: !!opts.force, expectedOwnerToken: previous?.owner_token });
  } catch (error) {
    throw new CliError(error.message);
  }

  const state = readState(configFile(opts));
  state.active = lock;
  state.last_run = now;
  writeState(state, configFile(opts));
  // Keep the owner lock if a tracker write fails; a retry with the same token
  // is idempotent and cannot be mistaken for an independent scheduler.
  if (rc.labels.working) journalIssueLabel({
    lock, provider, project, issue: number, label: rc.labels.working, action: 'add',
  });
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
  const lock = readLock(lockFile, configFile(opts));
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
  resumeLock(lock.owner_token, resumed);
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
  if (!AGENT_CHECKPOINTS.has(stage)) {
    throw new CliError(`checkpoint ${stage} is not agent-owned; use the command that verifies that workflow state`);
  }
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
  advanceCheckpointWorkflow(lock, stage);
  const next = saveCheckpoint(lock, stage, updates, opts);
  console.log(JSON.stringify({ checkpoint: next.stage, active: { ...next, owner_token: undefined } }, null, 2));
  return 0;
}

function cmdRelease(opts) {
  const lockFile = lockPath(configFile(opts));
  let lock;
  try {
    lock = readLock(lockFile, configFile(opts));
  } catch (error) {
    if (!String(error.message).startsWith('Legacy lock is corrupt:')) {
      throw new CliError(error.message);
    }
    if (!opts.force) {
      throw new CliError(`Lock is corrupt: ${error.message}; release --force to quarantine after confirming the old run stopped`);
    }
    if (!opts['confirm-stale']) {
      throw new CliError('release --force requires --confirm-stale before quarantining a corrupt legacy lock');
    }
    let quarantine;
    try {
      quarantine = quarantineCorruptLegacyLock(configFile(opts));
    } catch (quarantineError) {
      throw new CliError(quarantineError.message);
    }
    console.log(JSON.stringify({
      released: true,
      force: true,
      reason: 'corrupt legacy lock quarantined',
      quarantine: quarantine.lock,
      state_backup: quarantine.state,
    }, null, 2));
    return 0;
  }

  if (!lock) {
    console.log(JSON.stringify({ released: false, reason: 'no active lock' }, null, 2));
    return 0;
  }
  if (opts.force && !opts['confirm-stale']) {
    throw new CliError('release --force requires --confirm-stale after verifying the owner has stopped');
  }

  let result = opts.result ?? lock.release_result;
  if (result === undefined) {
    if (opts.force) result = 'none';
    else throw new CliError('release requires --result done|blocked|review|needs-info; use --force --confirm-stale for explicit recovery without an outcome');
  }
  if (!['done', 'blocked', 'review', 'needs-info', 'none'].includes(result)) {
    throw new CliError('--result must be done, blocked, review, needs-info or none');
  }
  if (result === 'none' && !opts.force) {
    throw new CliError('--result none is only allowed with --force --confirm-stale recovery');
  }

  if (!opts.force) assertOwner(lock, opts, 'release');
  let releaseContext;
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
    releaseContext = { rc, provider };
  }
  if (result !== 'none') {
    const outcome = result === 'done' ? 'DONE' : result === 'blocked' ? 'BLOCKED' :
      result === 'review' ? 'REVIEW' : 'NEEDS_INFO';
    try {
      const store = getRuntimeStore();
      if (store.workflowStateForOwner(lock.owner_token) !== outcome) {
        store.transitionWorkflow(
          lock.owner_token,
          outcome,
          'cli',
          opts.force ? `explicit stale recovery outcome: ${result}` : `release outcome recorded: ${result}`,
        );
      }
    } catch (error) {
      throw new CliError(error.message);
    }
  }
  if (releaseContext) {
    const { rc, provider } = releaseContext;
    if (rc.labels.working) journalIssueLabel({
      lock, provider, project: lock.repo, issue: lock.issue, label: rc.labels.working, action: 'remove',
    });
    const target = result === 'done'
      ? rc.labels.done
      : result === 'blocked'
        ? rc.labels.blocked
        : result === 'review'
          ? rc.labels.review
          : result === 'needs-info'
            ? rc.labels.needs_info
            : null;
    if (target) journalIssueLabel({
      lock, provider, project: lock.repo, issue: lock.issue, label: target, action: 'add',
    });
  }

  clearLock(lockFile, lock.owner_token, result);
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
  const lock = ownedLock(opts, { project, issue: Number(issue) });
  verifyAccount(provider, rc);
  const label = labelParts.join(' ');
  journalIssueLabel({ lock, provider, project, issue: Number(issue), label, action });
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
  const lock = kind === 'issue'
    ? ownedLock(opts, { project, issue: Number(number) })
    : ownedLock(opts, { project, change: Number(number) });
  verifyAccount(provider, rc);
  journalComment({ lock, provider, project, number: Number(number), kind, body, author: rc.account });
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
  if (!['IMPLEMENTED', 'CHANGE_OPEN'].includes(getRuntimeStore().workflowStateForOwner(lock.owner_token))) {
    throw new CliError('change-create requires workflow state IMPLEMENTED or a recoverable CHANGE_OPEN');
  }
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
  const intent = {
    project,
    issue: lock.issue,
    head: String(opts.head),
    base: String(opts.base),
    head_sha: headSha,
    title: String(opts.title),
    body_sha256: createHash('sha256').update(body).digest('hex'),
    draft: !!opts.draft,
  };
  const created = journaledWrite({
    lock,
    kind: 'change-create',
    identity: intent,
    intent,
    reconcile: () => {
      if (typeof provider.findChange !== 'function') {
        return { state: 'unknown', reason: `provider ${provider.name} cannot inspect change requests` };
      }
      const existing = provider.findChange({ project, head: String(opts.head), base: String(opts.base) });
      if (!existing) return { state: 'absent' };
      const view = provider.viewChange({ project, number: Number(existing.number) });
      if (view.state !== 'OPEN' || view.headRefName !== String(opts.head) || view.headRefOid !== headSha ||
          view.baseRefName !== String(opts.base) || !closesIssue(view.body, lock.issue)) {
        return { state: 'unknown', reason: 'an open change request exists but does not match this issue, branch, base and head' };
      }
      return { state: 'applied', result: existing };
    },
    apply: () => provider.createChange({
      project,
      head: String(opts.head),
      base: String(opts.base),
      title: String(opts.title),
      bodyFile: path.resolve(String(opts['body-file'])),
      draft: !!opts.draft,
    }),
  });
  const result = created.value as Record<string, any>;
  if (!Number.isSafeInteger(Number(result.number)) || Number(result.number) <= 0) {
    throw new CliError('provider did not return a reconciled change-request number; recovery is required');
  }
  const updated = saveCheckpoint(lock, 'change-created', {
    change_number: Number(result.number),
    branch: String(opts.head),
    head_sha: headSha,
  }, opts);
  if (getRuntimeStore().workflowStateForOwner(lock.owner_token) !== 'CHANGE_OPEN') {
    getRuntimeStore().transitionWorkflow(lock.owner_token, 'CHANGE_OPEN', 'cli', 'change request created or reconciled');
  }
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
  let workflowState = getRuntimeStore().workflowStateForOwner(lock.owner_token);
  if (!['REVIEWING', 'REVIEW_APPROVED', 'CHECKS_GREEN', 'MERGING', 'DONE'].includes(workflowState)) {
    throw new CliError(`workflow state is ${workflowState}; merge requires verified review progress`);
  }
  if (!['reviewed', 'checks-green', 'merge-pending', 'merged'].includes(lock.stage)) {
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

  const store = getRuntimeStore();
  if (workflowState === 'REVIEWING') {
    store.recordWorkflowCheck(lock.owner_token, 'review-approval', 'approved', lock.head_sha, {
      change: changeNumber,
      reviewers: [...new Set((finalView.reviews ?? []).map((review) => review.author?.login).filter(Boolean))],
    });
    store.transitionWorkflow(lock.owner_token, 'REVIEW_APPROVED', 'cli', 'trusted exact-head approval verified');
    workflowState = 'REVIEW_APPROVED';
  }
  if (workflowState === 'REVIEW_APPROVED') {
    store.recordWorkflowCheck(lock.owner_token, 'required-checks', 'green', lock.head_sha, { required: true });
    store.transitionWorkflow(lock.owner_token, 'CHECKS_GREEN', 'cli', 'required checks verified green for exact head');
    workflowState = 'CHECKS_GREEN';
  }
  if (workflowState === 'CHECKS_GREEN') {
    store.transitionWorkflow(lock.owner_token, 'MERGING', 'cli', 'merge intent authorized after final gates');
    workflowState = 'MERGING';
  }

  const mergeIdentity = { project, number: changeNumber, method: rc.merge_method, head_sha: lock.head_sha };
  const jobId = store.jobIdForOwner(lock.owner_token);
  const mergeEffects = store.sideEffectsForJob(jobId).filter((effect) => effect.kind === 'merge');
  const priorMerge = mergeEffects.find((effect) => {
    const value = effect.intent;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const intent = value as Record<string, unknown>;
    return intent.project === project && Number(intent.number) === changeNumber &&
      intent.method === rc.merge_method && intent.head_sha === lock.head_sha &&
      Number(intent.issue) === Number(lock.issue) && intent.branch === lock.branch &&
      intent.base === rc.base_branch && typeof intent.owner_token === 'string' && !!intent.owner_token;
  });
  if (mergeEffects.length > 1 || (mergeEffects.length > 0 && !priorMerge)) {
    throw new CliError('existing merge intent does not match this job; refusing to create another merge entry');
  }
  const priorIntent = priorMerge?.intent as Record<string, unknown> | undefined;
  const mergeIntent = {
    ...mergeIdentity,
    issue: Number(lock.issue),
    branch: lock.branch,
    base: rc.base_branch,
    owner_token: priorIntent?.owner_token ?? lock.owner_token,
  };
  const mergeKey = sideEffectKey(store, lock.owner_token, 'merge', mergeIntent);
  if (priorMerge && priorMerge.idempotencyKey !== mergeKey) {
    throw new CliError('existing merge intent has an inconsistent idempotency key; refusing merge');
  }
  const reconcileMerge = () => {
    const current = provider.viewChange({ project, number: changeNumber });
    if (current.state === 'MERGED' && current.headRefOid === lock.head_sha) {
      return { state: 'applied' as const, result: { state: current.state, head_sha: current.headRefOid } };
    }
    if (current.state === 'OPEN' && current.headRefOid === lock.head_sha) return { state: 'absent' as const };
    return { state: 'unknown' as const, reason: `change request is ${current.state} or its head no longer matches` };
  };

  if (alreadyMerged) {
    const recovered = journaledWrite({
      lock,
      kind: 'merge',
      identity: mergeIntent,
      intent: mergeIntent,
      reconcile: reconcileMerge,
      apply: () => { throw new Error('merge is already observed; refusing a second merge write'); },
    });
    store.recordMergedOutcome(lock.owner_token, lock.head_sha, { change: changeNumber, reconciled: true },
      'external merged state reconciled');
    crashAfterMergedOutcomeForTest();
    console.log(JSON.stringify({
      merged: true,
      already_merged: true,
      project,
      number: changeNumber,
      url: view.url ?? null,
      method: rc.merge_method,
      ...(recovered.value as Record<string, any>),
    }, null, 2));
    return 0;
  }

  saveCheckpoint(lock, 'merge-pending', {}, opts);
  const merged = journaledWrite({
    lock,
    kind: 'merge',
    identity: mergeIntent,
    intent: mergeIntent,
    reconcile: reconcileMerge,
    apply: () => provider.merge({ project, number: changeNumber, method: rc.merge_method, headSha: lock.head_sha }),
  });
  const result = merged.value as Record<string, any>;
  const mergedView = provider.viewChange({ project, number: changeNumber });
  if (mergedView.state !== 'MERGED' || mergedView.headRefOid !== lock.head_sha) {
    throw new CliError('provider merge response could not be reconciled with the external change request');
  }
  store.recordMergedOutcome(lock.owner_token, lock.head_sha, { change: changeNumber },
    'external merge verified at reviewed head');
  crashAfterMergedOutcomeForTest();
  console.log(JSON.stringify({
    merged: true,
    project,
    number: changeNumber,
    url: view.url ?? null,
    ...result,
  }, null, 2));
  return 0;
}

function crashAfterMergedOutcomeForTest() {
  if (process.env.NODE_ENV === 'test' && process.env.ISSUE_ORCHESTRATOR_TEST_CRASH_AFTER_MERGE_FINALIZED === '1') {
    process.kill(process.pid, 'SIGKILL');
  }
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
  if (!['CHANGE_OPEN', 'EVIDENCE_PUBLISHED'].includes(getRuntimeStore().workflowStateForOwner(lock.owner_token))) {
    throw new CliError('evidence requires workflow state CHANGE_OPEN or recoverable EVIDENCE_PUBLISHED');
  }
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
  const evidenceIdentity = {
    project,
    issue: Number(issue),
    change: Number(lock.change_number),
    head: view.headRefOid,
  };
  const preparedEvidence = prepareEvidenceManifest({
    ...evidenceIdentity,
    dir: String(opts.dir),
  });
  saveCheckpoint(lock, 'evidence-publishing', { head_sha: view.headRefOid }, opts);
  const store = getRuntimeStore();
  const evidenceKey = sideEffectKey(store, lock.owner_token, 'evidence', evidenceIdentity);
  const jobId = store.jobIdForOwner(lock.owner_token);
  const previousEffect = store.sideEffectsForJob(jobId)
    .find((effect) => effect.idempotencyKey === evidenceKey);
  const previousIntent = previousEffect?.intent as Record<string, unknown> | undefined;
  if (previousIntent && (!previousIntent.expected_manifest || typeof previousIntent.expected_manifest !== 'object')) {
    throw new CliError('existing evidence intent predates manifest binding; inspect the remote branch before explicit recovery');
  }
  if (previousIntent && !isDeepStrictEqual(previousIntent.expected_manifest, preparedEvidence.manifest)) {
    throw new CliError('local evidence differs from the journaled manifest; refusing to adopt or replace this job evidence');
  }
  const evidenceBranch = typeof previousIntent?.branch === 'string'
    ? previousIntent.branch
    : `${rc.evidence_branch_prefix}-issue-${issue}-head-${view.headRefOid.slice(0, 12)}-${randomBytes(16).toString('hex')}`;
  const evidenceIntent = {
    ...evidenceIdentity,
    branch: evidenceBranch,
    expected_manifest: preparedEvidence.manifest,
  };
  const publication = journaledWrite({
    lock,
    kind: 'evidence',
    identity: evidenceIdentity,
    intent: evidenceIntent,
    reconcile: () => {
      const result = reconcileEvidenceBranch({
        ...evidenceIdentity,
        branch: evidenceBranch,
        expectedManifest: preparedEvidence.manifest,
        rawUrl: (args) => provider.rawUrl(args),
      });
      return result ? { state: 'applied', result } : { state: 'absent' };
    },
    apply: () => publishEvidence({
      project,
      issue,
      change: lock.change_number,
      head: view.headRefOid,
      dir: String(opts.dir),
      branchPrefix: rc.evidence_branch_prefix,
      branch: evidenceBranch,
      preparedEvidence,
      rawUrl: (args) => provider.rawUrl(args),
    }),
  });
  const result = publication.value as Record<string, any>;
  saveCheckpoint(lock, 'evidence-published', {
    head_sha: view.headRefOid,
    evidence_commit: result.commit,
  }, opts);
  if (store.workflowStateForOwner(lock.owner_token) !== 'EVIDENCE_PUBLISHED') {
    store.transitionWorkflow(lock.owner_token, 'EVIDENCE_PUBLISHED', 'cli', 'evidence manifest verified on remote branch');
  }
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
      const intent = { project, name, ...definition, config_file: path.resolve(configFile(opts)) };
      const store = getRuntimeStore();
      const idempotencyKey = sideEffectKey(store, undefined, 'ensure-label', intent);
      runJournaledSideEffect({
        store,
        idempotencyKey,
        kind: 'ensure-label',
        intent,
        reconcile: () => observeRepoLabel(provider, project, name, definition),
        apply: () => provider.ensureLabel(intent),
      });
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

export { COMMANDS, HELP, CliError, parseArgs, reconcilePendingSideEffects };
