import { createHash } from 'node:crypto';
import type {
  ActivationMentionRequest,
  ActivationScanRequest,
  ActivationScanResult,
  TicketIssue,
} from '../providers/ticket-port.js';

export interface ActivationHandoffStore {
  readTicketHandoff(id: string): { state: Record<string, unknown> } | null;
}

export interface ActivationFailure {
  issue: number;
  error: string;
}

/** Content-free scan state persisted across polls and worker restarts. */
export interface ActivationStateSnapshot {
  revision: string;
  matched: boolean;
  completeRevision: string | null;
  nextPage: number | null;
  topPage: number | null;
  checkedAt: number;
  lastCompleteAt: number | null;
  failures: number;
}

export interface ActivationStateRecord extends ActivationStateSnapshot {
  key: string;
  project: string;
  issue: number;
  policy: string;
}

export interface ActivationStateStore extends ActivationHandoffStore {
  readTicketActivationState(key: string): ActivationStateRecord | null;
  writeTicketActivationState(record: ActivationStateRecord): void;
}

/**
 * Shared, time-based reservation bucket plus a durable per-project rotation.
 * One bucket per runtime database; every reservation is charged to a project so
 * a saturated repository cannot keep the front of the queue across polls.
 */
export interface ActivationBudgetStore {
  consumeTicketActivationBudget(requests: number, options: {
    now?: number; limit: number; windowMs: number; project: string;
  }): ActivationBudgetDecision;
}

/** Durable rolling-window log for the separate GitHub search budget. */
export interface ActivationSearchBudgetStore {
  consumeTicketSearchBudget(requests: number, options: {
    now?: number; limit: number; windowMs: number; project: string;
  }): ActivationBudgetDecision;
}

export interface ActivationBudgetDecision {
  granted: boolean;
  remaining: number;
  retryAt: number | null;
}

export interface ActivationApiBudget {
  /** Requests available per window across every poller and project. */
  limit: number;
  windowMs: number;
}

export interface ActivationIncomplete {
  issue: number;
  nextPage: number | null;
}

export interface ActivationEligibility {
  candidates: TicketIssue[];
  failures: ActivationFailure[];
  /** Issues left for a later poll because the per-poll check budget was exhausted. */
  deferred: number[];
  /** Issues backing off after a recent provider failure. */
  retrying: number[];
  /** Issues whose bounded comment scan has not reached its end yet. */
  incomplete: ActivationIncomplete[];
  /** Issues deferred without any provider call because the shared budget is empty. */
  budgetDenied: number[];
  /** When the shared activation API budget next admits a reservation. */
  budgetRetryAt: number | null;
  /** Provider activation checks actually started by this call. */
  checks: number;
}

/**
 * Hard bound on activation provider checks per repository per discovery pass.
 * Without it a saturated listing (up to 1000 issues) turns every poll into an
 * unbounded sequence of issue reads and comment pages.
 */
export const MAX_ACTIVATION_CHECKS_PER_POLL = 20;
/**
 * Hard bound on comment pages read for one issue in one check. The durable
 * `nextPage` cursor continues the descending scan on later polls, so a page cap
 * delays a deep mention instead of silently declaring the issue unmentioned.
 */
export const MAX_ACTIVATION_COMMENT_PAGES_PER_CHECK = 4;
/** Negative results are rechecked after this delay to cover second-precision timestamps. */
export const ACTIVATION_NEGATIVE_CACHE_MS = 5 * 60_000;
export const ACTIVATION_FAILURE_BASE_MS = 30_000;
export const ACTIVATION_FAILURE_MAX_MS = 60 * 60_000;
/**
 * Worst-case comment pages a legacy boolean activation check may read in the
 * provider. Reservations use it so a boolean-only provider is not undercounted.
 */
export const ACTIVATION_BOOLEAN_COMMENT_PAGES = 8;

/**
 * Shared activation API budget for issue reads. GitHub allows far more, but
 * ticket agents use the same token for their own reads and writes, and the
 * search endpoint has its own limit (see `ACTIVATION_SEARCH_BUDGET` below).
 * 45 requests/minute leaves most provider headroom while still allowing
 * roughly nine four-page scans or five boolean checks per minute across every
 * project and poller. This bucket never pays for mention searches.
 */
export const ACTIVATION_API_BUDGET: ActivationApiBudget = { limit: 45, windowMs: 60_000 };

/**
 * Shared budget for the GitHub search endpoint, 30 requests per minute for one
 * authenticated token. A token bucket with that capacity would still admit a
 * full burst plus its refill inside one minute (capacity + rate * window), so
 * the durable store keeps a rolling-window log instead: a grant is admitted
 * only while the summed cost of every grant in the preceding minute stays
 * within 30, which bounds any rolling minute across projects, pollers and
 * restarts, burst included.
 */
export const ACTIVATION_SEARCH_BUDGET: ActivationApiBudget = { limit: 30, windowMs: 60_000 };

/** Conservative request cost of one bounded mention search (100 results/page). */
export function activationSearchCost(results: number): number {
  const bounded = Number.isSafeInteger(results) ? Math.max(1, Math.min(results, 1000)) : 1000;
  return Math.min(10, Math.ceil(bounded / 100));
}

export function ticketRouteJobId(project: string, issue: number): string {
  return createHash('sha256').update(`ticket-router:${project.toLocaleLowerCase()}#${issue}`).digest('hex');
}

/** A content-free latch: any of these durable fields proves the session was already admitted. */
export function ticketHasBeenAdmitted(store: ActivationHandoffStore, project: string, issue: number): boolean {
  const state = store.readTicketHandoff(ticketRouteJobId(project, issue))?.state;
  return state?.activationAdmitted === true || state?.initialDispatched === true ||
    (typeof state?.initialProgress === 'number' && state.initialProgress > 0) ||
    (typeof state?.sessionId === 'string' && !!state.sessionId);
}

/** Policy digest keeps a cached boolean from crossing login or author-policy changes. */
function policyDigest(login: string, trustedAuthors: string[], excludedAuthors: string[]): string {
  return createHash('sha256').update([
    login.toLocaleLowerCase(),
    ...trustedAuthors.map((author) => author.toLocaleLowerCase()).sort(),
    '\u0000',
    ...excludedAuthors.map((author) => author.toLocaleLowerCase()).sort(),
  ].join('\u0000')).digest('hex').slice(0, 32);
}

export function ticketActivationStateKey(project: string, issue: number, login: string,
  trustedAuthors: string[], excludedAuthors: string[]): { key: string; policy: string } {
  const policy = policyDigest(login, trustedAuthors, excludedAuthors);
  return { key: `${project.toLocaleLowerCase()}#${issue}\u0000${policy}`, policy };
}

function failureDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(ACTIVATION_FAILURE_MAX_MS, ACTIVATION_FAILURE_BASE_MS * 2 ** Math.min(failures - 1, 8));
}

function sanitizedError(error: unknown): string {
  // Provider ports throw content-free messages for this path; bound the length
  // anyway so an unexpected error cannot flood persisted diagnostics.
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function durableStateStore(store: ActivationStateStore | undefined): ActivationStateStore | undefined {
  return store && typeof store.readTicketActivationState === 'function' &&
    typeof store.writeTicketActivationState === 'function' ? store : undefined;
}

function budgetStore(store: ActivationStateStore | undefined): ActivationBudgetStore | undefined {
  const candidate = store as unknown as Partial<ActivationBudgetStore> | undefined;
  return candidate && typeof candidate.consumeTicketActivationBudget === 'function'
    ? candidate as ActivationBudgetStore : undefined;
}

function searchBudgetStore(store: ActivationStateStore | undefined): ActivationSearchBudgetStore | undefined {
  const candidate = store as unknown as Partial<ActivationSearchBudgetStore> | undefined;
  return candidate && typeof candidate.consumeTicketSearchBudget === 'function'
    ? candidate as ActivationSearchBudgetStore : undefined;
}

/**
 * Reserve provider requests from the one shared, durable activation budget.
 * The reservation is the conservative worst case of the call that follows, so
 * an issue is never checked with an undercounted budget. Every granted
 * reservation is charged to `project` and moves that project to the back of the
 * durable cross-project rotation, so separate polls and intake ticks serve the
 * least recently served project first. Without a durable budget store (for
 * example a `--dry-run` or a test double) nothing is spent.
 */
export function reserveActivationApiBudget(store: ActivationStateStore | undefined, requests: number,
  options: { now?: number; budget?: ActivationApiBudget; project: string }): ActivationBudgetDecision {
  const durable = budgetStore(store);
  if (!durable) return { granted: true, remaining: Number.MAX_SAFE_INTEGER, retryAt: null };
  const budget = options.budget ?? ACTIVATION_API_BUDGET;
  return durable.consumeTicketActivationBudget(requests, {
    project: options.project,
    now: options.now ?? Date.now(), limit: budget.limit, windowMs: budget.windowMs,
  });
}

/**
 * Reserve mention-search requests from the separate shared search budget.
 * Charging search to the general activation bucket would let a burst spend
 * that bucket's full 45-request capacity on search, above GitHub's 30/minute
 * search limit. The dedicated rolling-window budget keeps every rolling minute
 * within 30 reserved requests and still advances the same durable project
 * rotation, so a saturated search cannot pin one project to the front.
 */
export function reserveActivationSearchBudget(store: ActivationStateStore | undefined, requests: number,
  options: { now?: number; budget?: ActivationApiBudget; project: string }): ActivationBudgetDecision {
  const durable = searchBudgetStore(store);
  if (!durable) return { granted: true, remaining: Number.MAX_SAFE_INTEGER, retryAt: null };
  const budget = options.budget ?? ACTIVATION_SEARCH_BUDGET;
  return durable.consumeTicketSearchBudget(requests, {
    project: options.project,
    now: options.now ?? Date.now(), limit: budget.limit, windowMs: budget.windowMs,
  });
}

export type ActivationCheckOutcome =
  | { status: 'admitted'; revision: string; requested: boolean }
  | { status: 'negative'; revision: string; requested: boolean }
  | { status: 'incomplete'; revision: string; nextPage: number | null; requested: boolean }
  | { status: 'backoff'; retryAt: number; requested: false }
  | { status: 'budget'; retryAt: number | null; requested: false }
  | { status: 'failure'; error: string; requested: boolean };

/**
 * Check one issue's activation mention with durable, content-free progress.
 *
 * The caller supplies the observed issue revision and (optionally) the shared
 * activation store. The function:
 * 1. reuses a durable positive or a fresh negative without a provider read;
 * 2. backs off a recently failing issue;
 * 3. reserves the worst-case request cost from the shared budget before any
 *    provider call, so an exhausted budget performs no API request at all;
 * 4. scans with both the newest page and the saved descending cursor, so an
 *    ordinary comment inspects new content without discarding history;
 * 5. persists the merged result (positives latch, stale revisions cannot
 *    overwrite newer state).
 */
export async function checkTicketActivation(args: {
  project: string;
  issue: number;
  updatedAt: string | null;
  login: string;
  trustedAuthors: string[];
  excludedAuthors: string[];
  store?: ActivationStateStore;
  hasActivationMention?: (request: ActivationMentionRequest) => Promise<boolean>;
  scanActivationMention?: (request: ActivationScanRequest) => Promise<ActivationScanResult>;
  /** Injectable clock for deterministic cache/backoff/budget tests. */
  now?: () => number;
  /** Per-check comment page budget; exposed for tests, never larger than the hard bound. */
  maxCommentPages?: number;
  /** Shared budget override; exposed for tests. */
  apiBudget?: ActivationApiBudget;
}): Promise<ActivationCheckOutcome> {
  const now = args.now ?? Date.now;
  const maxCommentPages = Math.max(1, Math.min(args.maxCommentPages ?? MAX_ACTIVATION_COMMENT_PAGES_PER_CHECK,
    MAX_ACTIVATION_COMMENT_PAGES_PER_CHECK));
  const store = args.store;
  const durable = durableStateStore(store);
  const location = ticketActivationStateKey(args.project, args.issue, args.login,
    args.trustedAuthors, args.excludedAuthors);
  const state = durable?.readTicketActivationState(location.key) ?? null;
  // A retained association is rediscovered without an issue timestamp (the
  // listing read only fetches identity). The durable revision is then the best
  // available cache key; the provider still reports the revision it observed.
  const revision = args.updatedAt ?? state?.revision ?? '';
  if (state?.matched) {
    // A durable positive admission survives worker restarts. It is written
    // before the ticket handoff exists, so a crash cannot re-gate the issue.
    return { status: 'admitted', revision, requested: false };
  }
  if (state && state.revision === revision && state.completeRevision === revision &&
      now() - state.checkedAt < ACTIVATION_NEGATIVE_CACHE_MS) {
    // Same revision was scanned to the end recently; no new content exists.
    return { status: 'negative', revision, requested: false };
  }
  if (state && now() < state.checkedAt + failureDelay(state.failures)) {
    // A failing issue yields the budget to others instead of retrying every poll.
    return { status: 'backoff', retryAt: state.checkedAt + failureDelay(state.failures), requested: false };
  }
  const requests = 1 + (args.scanActivationMention ? maxCommentPages : ACTIVATION_BOOLEAN_COMMENT_PAGES);
  const reservation = reserveActivationApiBudget(store, requests, {
    project: args.project,
    now: now(),
    ...(args.apiBudget ? { budget: args.apiBudget } : {}),
  });
  if (!reservation.granted) {
    return { status: 'budget', retryAt: reservation.retryAt, requested: false };
  }
  const snapshot: ActivationStateSnapshot = state
    ? { ...state }
    : { revision, matched: false, completeRevision: null, nextPage: null, topPage: null,
      checkedAt: 0, lastCompleteAt: null, failures: 0 };
  const writeState = (next: ActivationStateSnapshot) => {
    if (!durable) return;
    try {
      durable.writeTicketActivationState({
        key: location.key,
        project: args.project,
        issue: args.issue,
        policy: location.policy,
        ...next,
      });
    } catch {
      // A durable cache write must not turn a provider result into a failure.
      // The next poll simply retries from the previous cursor.
    }
  };
  try {
    let scan: ActivationScanResult;
    if (args.scanActivationMention) {
      scan = await args.scanActivationMention({
        project: args.project,
        number: args.issue,
        login: args.login,
        trustedAuthors: args.trustedAuthors,
        excludedAuthors: args.excludedAuthors,
        updatedAt: args.updatedAt,
        page: state?.nextPage ?? null,
        knownTop: state?.topPage ?? null,
        // Once any revision was scanned to the end, every page up to the saved
        // top stays complete because comments are only appended. A later
        // revision then re-checks just the newest range instead of the thread.
        resumeComplete: state?.completeRevision !== null && state?.completeRevision !== undefined,
        // A changed revision or an expired negative check inspects the newest
        // page first; an in-progress historical scan continues its cursor.
        newest: !state || state.revision !== revision || state.completeRevision === revision,
        maxPages: maxCommentPages,
      });
    } else if (args.hasActivationMention) {
      const matched = await args.hasActivationMention({
        project: args.project,
        number: args.issue,
        login: args.login,
        trustedAuthors: args.trustedAuthors,
        excludedAuthors: args.excludedAuthors,
        updatedAt: args.updatedAt,
      });
      scan = { matched, complete: true, nextPage: null, revision, topPage: null };
    } else {
      throw new Error('GitHub activation mention check is unavailable');
    }
    const checkedAt = now();
    if (scan.matched) {
      writeState({
        revision: scan.revision,
        matched: true,
        completeRevision: scan.revision,
        nextPage: null,
        topPage: scan.topPage ?? null,
        checkedAt,
        lastCompleteAt: checkedAt,
        failures: 0,
      });
      return { status: 'admitted', revision: scan.revision, requested: true };
    }
    if (scan.complete) {
      writeState({
        revision: scan.revision,
        matched: false,
        completeRevision: scan.revision,
        nextPage: null,
        topPage: scan.topPage ?? null,
        checkedAt,
        lastCompleteAt: checkedAt,
        failures: 0,
      });
      return { status: 'negative', revision: scan.revision, requested: true };
    }
    // Never report an incomplete scan as a negative: the durable cursor
    // continues from the next older page on a later poll.
    writeState({
      revision: scan.revision,
      matched: false,
      // An incomplete range must never look like a completed negative, even
      // when the revision itself did not change (for example a page growth
      // noticed after the negative cache expired).
      completeRevision: null,
      nextPage: scan.nextPage,
      topPage: scan.topPage ?? state?.topPage ?? null,
      checkedAt,
      lastCompleteAt: state?.lastCompleteAt ?? null,
      failures: 0,
    });
    return { status: 'incomplete', revision: scan.revision, nextPage: scan.nextPage, requested: true };
  } catch (error) {
    writeState({
      ...snapshot,
      // Keep prior progress but record the failure time so this issue yields
      // the next polls to others while backing off.
      checkedAt: now(),
      failures: Math.min(snapshot.failures + 1, 8),
    });
    return { status: 'failure', error: sanitizedError(error), requested: true };
  }
}

/**
 * Check the activation mention per issue under a hard per-pass budget.
 *
 * Checks are ordered by a durable, content-free rotation: an issue whose
 * `updatedAt` revision changed is checked first, then the least recently
 * checked issue. An exhausted per-pass or shared API budget is reported so a
 * later poll continues fairly instead of silently skipping candidates. Comment
 * scans are bounded and their descending page cursor is durable, so a mention
 * deeper in a long (and attacker-amplifiable) thread is reachable across polls
 * and never becomes a silent negative. Already admitted issues need no content
 * read at all.
 */
export async function activationEligibleCandidates(args: {
  candidates: TicketIssue[];
  project: string;
  login: string | undefined;
  trustedAuthors: string[];
  excludedAuthors: string[];
  store?: ActivationStateStore;
  hasActivationMention?: (request: ActivationMentionRequest) => Promise<boolean>;
  scanActivationMention?: (request: ActivationScanRequest) => Promise<ActivationScanResult>;
  /** Injectable clock for deterministic cache/backoff/fairness tests. */
  now?: () => number;
  /** Per-pass check budget; exposed for tests, never larger than the hard bound. */
  maxChecks?: number;
  /** Per-check comment page budget; exposed for tests, never larger than the hard bound. */
  maxCommentPages?: number;
  /** Shared budget override; exposed for tests. */
  apiBudget?: ActivationApiBudget;
}): Promise<ActivationEligibility> {
  const result: ActivationEligibility = {
    candidates: [], failures: [], deferred: [], retrying: [], incomplete: [],
    budgetDenied: [], budgetRetryAt: null, checks: 0,
  };
  if (!args.login) {
    return { ...result, candidates: args.candidates };
  }
  const now = args.now ?? Date.now;
  const budget = Math.max(1, Math.min(args.maxChecks ?? MAX_ACTIVATION_CHECKS_PER_POLL,
    MAX_ACTIVATION_CHECKS_PER_POLL));
  const store = args.store;
  const durable = durableStateStore(store);

  type Pending = { issue: TicketIssue; state: ActivationStateRecord | null; revisionChanged: boolean };
  const pending: Pending[] = [];
  for (const issue of args.candidates) {
    if (store && ticketHasBeenAdmitted(store, args.project, issue.number)) {
      result.candidates.push(issue);
      continue;
    }
    const revision = issue.updatedAt ?? '';
    const location = ticketActivationStateKey(args.project, issue.number, args.login,
      args.trustedAuthors, args.excludedAuthors);
    const state = durable?.readTicketActivationState(location.key) ?? null;
    if (state?.matched) {
      result.candidates.push(issue);
      continue;
    }
    if (state && state.revision === revision && state.completeRevision === revision &&
        now() - state.checkedAt < ACTIVATION_NEGATIVE_CACHE_MS) {
      continue;
    }
    if (state && now() < state.checkedAt + failureDelay(state.failures)) {
      result.retrying.push(issue.number);
      continue;
    }
    pending.push({ issue, state, revisionChanged: !state || state.revision !== revision });
  }

  // Revision changes win, then least-recently checked, then issue number. The
  // stable order means every candidate is eventually reached even when the
  // budget is smaller than the candidate set.
  pending.sort((a, b) =>
    Number(b.revisionChanged) - Number(a.revisionChanged) ||
    (a.state?.checkedAt ?? 0) - (b.state?.checkedAt ?? 0) ||
    a.issue.number - b.issue.number);
  const selected = pending.slice(0, budget);
  result.deferred.push(...pending.slice(budget).map((entry) => entry.issue.number));

  for (let index = 0; index < selected.length; index += 1) {
    const entry = selected[index];
    const outcome = await checkTicketActivation({
      project: args.project,
      issue: entry.issue.number,
      updatedAt: entry.issue.updatedAt,
      login: args.login,
      trustedAuthors: args.trustedAuthors,
      excludedAuthors: args.excludedAuthors,
      ...(store ? { store } : {}),
      ...(args.scanActivationMention ? { scanActivationMention: args.scanActivationMention } : {}),
      ...(args.hasActivationMention ? { hasActivationMention: args.hasActivationMention } : {}),
      now,
      ...(args.maxCommentPages !== undefined ? { maxCommentPages: args.maxCommentPages } : {}),
      ...(args.apiBudget ? { apiBudget: args.apiBudget } : {}),
    });
    if (outcome.status === 'budget') {
      // Stop before any further reservation or provider call so an exhausted
      // budget cannot turn into a request storm. Everything not yet checked is
      // reported for a later poll.
      result.budgetDenied.push(...selected.slice(index).map((pendingEntry) => pendingEntry.issue.number));
      result.budgetRetryAt = outcome.retryAt;
      break;
    }
    if (outcome.requested) result.checks += 1;
    switch (outcome.status) {
      case 'admitted':
        result.candidates.push(entry.issue);
        break;
      case 'negative':
        break;
      case 'incomplete':
        result.incomplete.push({ issue: entry.issue.number, nextPage: outcome.nextPage });
        break;
      case 'backoff':
        result.retrying.push(entry.issue.number);
        break;
      case 'failure':
        result.failures.push({ issue: entry.issue.number, error: outcome.error });
        break;
    }
  }
  // A shared budget denial also covers candidates the per-pass budget already
  // deferred; report them once so an operator sees why nothing moved.
  if (result.budgetDenied.length) {
    result.budgetDenied.push(...result.deferred);
    result.deferred = [];
  }
  return result;
}
