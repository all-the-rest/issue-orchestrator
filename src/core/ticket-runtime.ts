import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_TICKET_LEASE_MS, type SQLiteStore } from './persistence.js';
import {
  createTicketHandoff, DEFAULT_TICKET_INSTRUCTION, humanTicketComments, normalizeTicket, serializeTicketHandoff,
  sanitizeTicketText, TICKET_AGENT_SYSTEM_PROMPT,
  type NormalizedTicket, type TicketAgentMode, type TicketComment, type TicketMergePolicy,
} from './ticket-handoff.js';
import type { AgentResult, AgentResultStatus } from '../providers/ports.js';
import { validateAgentResult } from '../providers/agent-result.js';
import type { TicketIssue, TicketPort } from '../providers/ticket-port.js';
import {
  EVENT_NOTIFICATION_NOTE,
  aggregateEventMetadata,
  classifyPullRequestTransition,
  metadataFromTicketUpdate,
  normalizeEventMetadata,
  type EventMetadata,
} from './event-metadata.js';
import { evaluateDelivery, type DeliveryDecision, type DeliverySchedule } from './delivery-window.js';
import { checkTicketActivation } from './ticket-activation.js';

type TicketSnapshot = Omit<NormalizedTicket, 'updatedAt' | 'comments'>;
type StatusName = 'started' | 'finished';

/** Merged/closed PRs are polled at most this often by default. */
export const DEFAULT_TICKET_POST_MERGE_POLL_MS = 5 * 60 * 1000;
/** Retired PRs polled per turn; rotatation by lastPolledAt prevents starvation. */
export const DEFAULT_TICKET_POST_MERGE_POLL_LIMIT = 2;

interface StatusKeys { started: string; finished: string }
interface StatusTurn {
  statusKeys: StatusKeys;
  statusIds: Record<string, string>;
  finalStatusBody: string;
}
interface TicketTurn extends StatusTurn {
  id: string;
  message: string;
  sessionId: string | null;
  ticket: NormalizedTicket;
  cursor: string | null;
  changedFields: string[];
  statusMode: TicketAgentMode;
  dispatched: boolean;
  /** Number of configured bootstrap messages already dispatched in this turn. */
  progress?: number;
  operatorRetry?: boolean;
  finalized?: boolean;
  result: AgentResult | null;
  summary: string;
}
interface TurnHistoryEntry {
  id: string;
  result: AgentResult;
  summary: string;
  message?: string;
  statusKeys?: StatusKeys;
}
interface FailureStatus extends StatusTurn { initialRead?: boolean }
interface TrackedPullRequest {
  number: number;
  url: string;
  /** Provider cursor for this pull request's conversation/reviews. */
  cursor?: string | null;
  /** Last verified GitHub state (OPEN/MERGED/CLOSED); null before the first verification. */
  state?: string | null;
  /** Epoch milliseconds of the last poll attempt; drives fair round-robin ordering. */
  lastPolledAt?: number | null;
  /** Consecutive read failures for per-PR backoff. */
  failures?: number;
  /** Legacy retired rows snapshot their cursor once instead of replaying history. */
  cursorSeeded?: boolean;
}

interface TicketHandoffState {
  ticket: NormalizedTicket;
  mergePolicy: TicketMergePolicy;
  cursor: string | null;
  /** Cursor for the ticket's change-request conversation, separate from issue comments. */
  changeCursor: string | null;
  /** The active cursor is seeded at the head; null means "snapshot before forwarding". */
  changeCursorSeeded?: boolean;
  /** Consecutive active-PR read/verify failures for exponential backoff. */
  changeFailures?: number;
  /** Epoch milliseconds of the last active-PR poll attempt. */
  changeLastPolledAt?: number | null;
  /** Last verified state of the active association. */
  changeState?: string | null;
  /** Same-repository pull request reported by the ticket agent. */
  pullRequest: { number: number; url: string } | null;
  /** Replacement pull request waiting for the current association to close. */
  pendingPullRequest: { number: number; url: string } | null;
  /** Merged/closed pull requests retained for continued post-merge routing. */
  retiredPullRequests: TrackedPullRequest[];
  routeCursorSeeded?: boolean;
  routeGoalHashes?: string[];
  workflow?: 'route-only' | 'goal';
  /** Content-free latch: a configured activation mention was observed before first admission. */
  activationAdmitted?: boolean;
  sessionId: string | null;
  initialDispatched: boolean;
  /** Bootstrap messages already dispatched for the initial turn. */
  initialProgress: number;
  state: 'active' | 'REVIEW' | AgentResultStatus;
  terminal: boolean;
  statusKeys: StatusKeys;
  statusIds: Record<string, string>;
  turns: TurnHistoryEntry[];
  pendingTurn: TicketTurn | null;
  result: AgentResult | null;
  summary: string;
  finalStatusBody: string;
  failureStatus: FailureStatus | null;
  deferredUpdates: TicketComment[];
  deferredFields: string[];
  /** Epoch milliseconds at which the current event burst may be delivered. */
  quietUntil?: number | null;
  /** Association was skipped/failed closed without failing the turn. */
  associationDeferred?: string | null;
}

interface UpdateMessageData {
  updates: TicketComment[];
  changedFields: string[];
}

export type TicketDispatch = (input: {
  /** Stable across retries; adapter uses this to find/create the runner job. */
  handoffId: string;
  /** Null requests adapter-side recovery/creation; otherwise resume this real runner session. */
  sessionId: string | null;
  bootstrap: string;
  message: string;
  /** Configured turn instruction; one dispatch per bootstrap entry. */
  instruction: string;
  /** Present only for a persisted completed-run follow-up. */
  continueCompleted?: true;
  turnId?: string;
}) => Promise<{ sessionId: string; result: unknown }>;

export interface TicketRuntimePolicy {
  /** Optional operator criteria; route-only mode forwards it separately from GitHub event data. */
  goal?: string;
  mergePolicy: TicketMergePolicy;
  autoImplementLabel: string;
  retryBlocked?: boolean;
  toolAuthors?: string[];
  trustedAuthors?: string[];
  summarize?: (result: AgentResult) => string;
  /** Route event references only; the agent fetches all ticket/PR content itself. */
  routeOnly?: boolean;
  ticketUrl?: string;
  /** Optional per-repository login required for the first route-only bootstrap. */
  activationMention?: string;
  /**
   * Discovery in this poll already proved admission (or the durable admission
   * latch). Skips a second provider activation read before the first dispatch.
   */
  activationPreverified?: boolean;
  /** Listing/identity timestamp used only for the provider's in-memory mention cache. */
  activationUpdatedAt?: string | null;
  /** Ordered turn instructions; each entry becomes one turn in the same session. */
  bootstrap?: string[];
  systemPrompt?: string;
  /** Global cap on simultaneously executing ticket sessions. */
  maxConcurrentSessions?: number;
  /** Durable coalescing window for follow-up ticket events; 0 dispatches immediately. */
  quietPeriodMs?: number;
  /** Minimum interval between polls of one merged/closed PR conversation. */
  postMergePollMs?: number;
  /** Maximum retired PRs polled per turn; fair round-robin prevents starvation. */
  postMergePollLimit?: number;
  /**
   * Automated dispatch windows and global cooldown. Absent for explicit
   * operator commands such as `goal`, which intentionally bypass windows.
   */
  delivery?: DeliverySchedule;
  /** Observe and persist events without dispatching or consuming a session slot. */
  intakeOnly?: boolean;
  /** True once SIGTERM/SIGINT cleanup started; aborts must not become FAILED. */
  isCancelled?: () => boolean;
}

export interface TicketRuntimeOutcome {
  jobId: string;
  sessionId: string | null;
  state: 'active' | 'deferred' | 'done' | 'blocked' | 'needs-info' | 'review' | 'failed';
  result?: AgentResult;
  summary?: string;
  pullRequest?: { number: number; url: string } | null;
  statusPending?: boolean;
  /** True when no dispatch happened but the durable workflow was left retryable. */
  deferred?: boolean;
  reason?: 'busy' | 'capacity' | 'quiet-period' | 'delivery-window' | 'cooldown' |
    'activation-mention' | 'activation-scan' | 'activation-budget';
  /** ISO timestamp of the durable quiet-period deadline. */
  quietUntil?: string;
  /** ISO timestamp of the next delivery-window or cooldown opportunity. */
  retryAt?: string;
  /** ISO timestamp at which the global start-to-start cooldown expires. */
  cooldownUntil?: string;
  /** Number of event identities retained for the next turn. */
  pendingEvents?: number;
  /** The run was interrupted for shutdown and remains resumable. */
  interrupted?: boolean;
}

function safeText(value: string, max = 12000): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from untrusted ticket text
  return sanitizeTicketText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

function defaultTicketGoal(ticket: NormalizedTicket): string {
  const heading = `Implement GitHub issue #${ticket.number}: ${ticket.title || 'untitled ticket'}`;
  const body = ticket.body.trim();
  return body ? `${heading}\n\n${body}` : `${heading}.`;
}

function scrubTicket(ticket: NormalizedTicket): NormalizedTicket {
  return { ...ticket, title: safeText(ticket.title, 1000), body: safeText(ticket.body),
    author: ticket.author ? safeText(ticket.author, 500) : null,
    labels: ticket.labels.map((label) => safeText(label, 500)), url: ticket.url ? safeText(ticket.url, 1000) : null,
    state: ticket.state ? safeText(ticket.state, 100) : null,
    updatedAt: ticket.updatedAt ? safeText(ticket.updatedAt, 100) : null,
    comments: ticket.comments.map((c) => ({ ...c, author: c.author ? safeText(c.author, 500) : null,
      id: safeText(c.id, 200), body: safeText(c.body),
      createdAt: c.createdAt ? safeText(c.createdAt, 100) : null,
      url: c.url ? safeText(c.url, 1000) : null })) };
}

function validateResult(value: unknown, project: string): value is AgentResult {
  try {
    const result = validateAgentResult(value);
    const repoPath = `/${project.toLocaleLowerCase()}/`;
    return !result.references?.some((reference) => !new URL(reference.url).pathname.toLocaleLowerCase().startsWith(repoPath));
  } catch {
    return false;
  }
}

function statusFor(result: AgentResultStatus): TicketRuntimeOutcome['state'] {
  return result === 'DONE' ? 'done' : result === 'BLOCKED' ? 'blocked' : result === 'NEEDS_INFO' ? 'needs-info' : 'review';
}
function displayedStatus(result: AgentResultStatus): string { return result === 'CHANGES_REQUIRED' ? 'REVIEW' : result; }
function safeSummary(result: AgentResult, summarize?: (result: AgentResult) => string): string {
  const raw = summarize ? summarize(result) : ['BLOCKED', 'NEEDS_INFO'].includes(result.status)
    ? result.blocked_reason ?? 'Agent is blocked; operator input is required.'
    : result.status === 'CHANGES_REQUIRED' ? 'Agent reports changes are still required.' : result.summary;
  const safe = safeText(raw.replace(/\s+/g, ' ').trim(), 400)
    .replace(/https?:\/\/[^\s<>]+/gi, '[link omitted]')
    .replace(/@/g, '@\u200b')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+.!|]/g, '\\$&');
  return safe || 'Agent finished; see the structured result.';
}
function nextAction(result: AgentResult, mergePolicy: TicketMergePolicy): string {
  if (['BLOCKED', 'NEEDS_INFO'].includes(result.status)) return 'Next action: provide the requested information in the ticket thread.';
  if (result.status === 'CHANGES_REQUIRED') return 'Next action: review the requested changes with the agent.';
  if (mergePolicy === 'manual') {
    return 'Next action: review the agent result and merge manually in GitHub only after project-required checks pass; this status does not assert CI passed.';
  }
  return 'Next action: review the agent result; the selected project integration must observe required checks and enforce its merge policy. This status does not assert CI passed.';
}
function referenceText(result: AgentResult, project: string): string {
  const repoPath = `/${project.toLocaleLowerCase()}/`;
  const references = (result.references ?? []).filter((reference) =>
    new URL(reference.url).pathname.toLocaleLowerCase().startsWith(repoPath)).slice(0, 5);
  if (!references.length) return '';
  return ` Agent-provided links (not verified by this bridge): ${references.map((reference) =>
    `${reference.kind === 'pull_request' ? 'PR' : 'Checks'} ${reference.url}`).join('; ')}.`;
}
function handoff(ticket: NormalizedTicket, goal: string, mergePolicy: TicketMergePolicy, kind: 'initial' | 'update', updates?: TicketComment[]) {
  return { ...createTicketHandoff({ ticket, finalAcceptanceCriteria: goal, mergePolicy, updates }), kind };
}
function updateMessage(ticket: NormalizedTicket, goal: string, mergePolicy: TicketMergePolicy, updates: TicketComment[], changedFields: string[]) {
  return JSON.stringify({ ...handoff(ticket, goal, mergePolicy, 'update', updates), changedFields });
}
function metadataFor(comment: TicketComment): EventMetadata | null {
  try {
    if (comment.category) {
      return normalizeEventMetadata({
        category: comment.category as EventMetadata['category'],
        id: comment.id,
        ...(comment.url ? { url: comment.url } : {}),
        ...(comment.createdAt ? { occurredAt: comment.createdAt } : {}),
      });
    }
    return metadataFromTicketUpdate(comment);
  } catch {
    // Classification is best-effort metadata; an odd provider identity must not
    // prevent the event itself from being delivered.
    return null;
  }
}
function routedEventMessage(ticket: NormalizedTicket, kind: 'initial' | 'update', updates: TicketComment[],
  changedFields: string[], acceptanceCriteria?: string) {
  const metadata: EventMetadata[] = [];
  const categories = new Map<string, string>();
  for (const comment of updates) {
    const event = metadataFor(comment);
    if (!event) continue;
    metadata.push(event);
    categories.set(updateKey(comment), event.category);
  }
  const digest = aggregateEventMetadata(metadata);
  return JSON.stringify({
    protocol: 'issue-orchestrator.ticket-event.v1',
    kind,
    project: ticket.project,
    issue: ticket.number,
    ticketUrl: ticket.url,
    changedFields,
    events: updates.map((comment) => ({ id: comment.id, author: comment.author,
      createdAt: comment.createdAt, url: comment.url, source: comment.source ?? 'ticket',
      ...(categories.has(updateKey(comment)) ? { category: categories.get(updateKey(comment)) } : {}) })),
    // Compact metadata-only digest: full per-category counts plus bounded
    // references. Bodies are never included; the agent fetches details itself.
    digest,
    note: EVENT_NOTIFICATION_NOTE,
    ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
  });
}
function messageFor(policy: TicketRuntimePolicy, ticket: NormalizedTicket, goal: string,
  mergePolicy: TicketMergePolicy, kind: 'initial' | 'update', updates: TicketComment[] = [], changedFields: string[] = [],
  acceptanceCriteria?: string) {
  return policy.routeOnly
    ? routedEventMessage(ticket, kind, updates, changedFields, acceptanceCriteria)
    : kind === 'initial'
      ? serializeTicketHandoff(handoff(ticket, goal, mergePolicy, kind))
      : updateMessage(ticket, goal, mergePolicy, updates, changedFields);
}
function routedTicket(project: string, issue: number, url: string, autoImplementLabel: string,
  toolAuthors?: string[]): NormalizedTicket {
  const minimal = normalizeTicket({ project, number: issue, title: '', body: '', labels: [autoImplementLabel],
    url, comments: [] }, { autoImplementLabel, toolAuthors });
  return { ...minimal, mode: 'auto-implement' };
}
function pullRequestFromResult(result: AgentResult, project: string): {
  reported: { number: number; url: string } | null; ambiguous: boolean;
} {
  const matches = new Map<number, { number: number; url: string }>();
  for (const reference of result.references ?? []) {
    if (reference.kind !== 'pull_request') continue;
    const match = reference.url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/i);
    if (match && match[1].toLocaleLowerCase() === project.toLocaleLowerCase()) {
      const number = Number(match[2]);
      matches.set(number, { number, url: reference.url });
    }
  }
  // Ambiguity fails association closed, not the turn: the agent result may be
  // valid even when its references are not safe to adopt.
  if (matches.size > 1) return { reported: null, ambiguous: true };
  return { reported: matches.values().next().value ?? null, ambiguous: false };
}
function retirePullRequest(state: TicketHandoffState, association: { number: number; url: string; state: string },
  cursor: string | null, lastPolledAt: number) {
  const entry = state.retiredPullRequests.find((item) => item.number === association.number);
  const tracked: TrackedPullRequest = entry ?? { number: association.number, url: association.url };
  tracked.url = association.url;
  tracked.cursor = cursor;
  tracked.cursorSeeded = true;
  tracked.state = association.state;
  tracked.lastPolledAt = lastPolledAt;
  tracked.failures = 0;
  if (!entry) state.retiredPullRequests.push(tracked);
  state.pullRequest = null;
  state.changeState = null;
  state.changeCursorSeeded = false;
  state.changeFailures = 0;
  state.changeLastPolledAt = null;
  // The cursor moved to the retained row; it is never discarded on merge.
  state.changeCursor = null;
}
function recordPullRequest(state: TicketHandoffState, result: AgentResult, project: string) {
  const { reported, ambiguous } = pullRequestFromResult(result, project);
  if (ambiguous) {
    state.associationDeferred = 'agent reported multiple pull requests; association not changed';
    return;
  }
  if (!reported) return;
  const retired = state.retiredPullRequests.find((entry) => entry.number === reported.number);
  if (!state.pullRequest) {
    if (retired) {
      // A reopened pull request is only re-associated after verification.
      state.pendingPullRequest = reported;
      return;
    }
    state.pullRequest = reported;
    state.pendingPullRequest = null;
    state.changeCursor = null;
    state.changeCursorSeeded = false;
    state.changeFailures = 0;
    state.changeLastPolledAt = null;
    state.changeState = null;
    state.associationDeferred = null;
    return;
  }
  if (state.pullRequest.number === reported.number) return;
  // The previous association must be verified as closed before it is replaced.
  state.pendingPullRequest = reported;
}
function snapshot(ticket: NormalizedTicket): TicketSnapshot {
  const { updatedAt: _updatedAt, comments: _comments, ...meaningful } = ticket;
  // GitHub project ids are case-insensitive; spelling aliases must not create a
  // synthetic ticket-change turn.
  return { ...meaningful, project: meaningful.project.toLocaleLowerCase() };
}
function changedTicketFields(current: NormalizedTicket, previous: NormalizedTicket): string[] {
  const currentSnapshot = snapshot(current);
  const previousSnapshot = snapshot(previous);
  return (Object.keys(currentSnapshot) as (keyof TicketSnapshot)[]).filter((key) =>
    JSON.stringify(currentSnapshot[key]) !== JSON.stringify(previousSnapshot[key]));
}
function publicOutcome(jobId: string, state: TicketHandoffState, pending = false): TicketRuntimeOutcome {
  const result = state.result;
  return { jobId, sessionId: state.sessionId, state: state.state === 'REVIEW' ? 'review' : result ? statusFor(result.status) : 'active',
    ...(result ? { result, summary: state.summary } : {}), ...(state.pullRequest ? { pullRequest: state.pullRequest } : {}),
    ...(pending ? { statusPending: true } : {}) };
}

function updateKey(comment: TicketComment): string {
  return `${comment.source ?? 'ticket'}:${comment.id}`;
}

function trailingNumericId(comment: TicketComment): number | null {
  const match = /([0-9]+)$/.exec(comment.id);
  return match ? Number(match[1]) : null;
}

function compareTicketUpdates(a: TicketComment, b: TicketComment): number {
  const byTime = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  if (byTime) return byTime;
  const left = trailingNumericId(a);
  const right = trailingNumericId(b);
  if (left !== null && right !== null && left !== right) return left - right;
  return updateKey(a).localeCompare(updateKey(b));
}

function sortTicketUpdates(updates: TicketComment[]): TicketComment[] {
  return [...updates].sort(compareTicketUpdates);
}

/** Merge a burst into durable state; the map deduplicates replayed event identities. */
function mergeDeferredUpdates(state: TicketHandoffState, updates: TicketComment[], changedFields: string[]) {
  const merged = new Map<string, TicketComment>();
  for (const comment of [...(state.deferredUpdates ?? []), ...updates]) merged.set(updateKey(comment), comment);
  state.deferredUpdates = sortTicketUpdates([...merged.values()]);
  state.deferredFields = [...new Set([...(state.deferredFields ?? []), ...changedFields])];
}

/**
 * Route-only handoffs persist event identities, not content. The agent fetches
 * issue/comment/review bodies itself; the durable pending batch and the
 * dispatched notification must never retain them.
 */
function metadataOnlyUpdates(updates: TicketComment[]): TicketComment[] {
  return updates.map((comment) => comment.body ? { ...comment, body: '' } : comment);
}

function deferredOutcome(jobId: string, state: TicketHandoffState,
  reason: 'busy' | 'capacity' | 'quiet-period' | 'delivery-window' | 'cooldown',
  decision?: DeliveryDecision): TicketRuntimeOutcome {
  // Report the durable deferred batch for every deferred outcome, including
  // busy/capacity: those callers still want to know whether events are waiting
  // without starting a turn. A persisted pending turn is not double-counted;
  // its events are delivered from the turn itself and `deferredUpdates` is empty.
  const pendingEvents = state.deferredUpdates?.length ?? 0;
  return { jobId, sessionId: state.sessionId, state: 'deferred', deferred: true, reason,
    ...(reason === 'quiet-period' && state.quietUntil ? { quietUntil: new Date(state.quietUntil).toISOString() } : {}),
    ...(decision?.retryAt ? { retryAt: decision.retryAt } : {}),
    ...(decision?.cooldownUntil ? { cooldownUntil: decision.cooldownUntil } : {}),
    pendingEvents };
}

function parseUpdateMessage(message: string): UpdateMessageData {
  let value: unknown;
  try { value = JSON.parse(message); } catch { throw new Error('persisted update turn is invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('persisted update turn is invalid');
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.updates) || !data.updates.every((entry) => isTicketComment(entry)) ||
      !Array.isArray(data.changedFields) || !data.changedFields.every((field) => typeof field === 'string')) {
    throw new Error('persisted update turn is invalid');
  }
  return { updates: data.updates, changedFields: data.changedFields };
}

function isTicketComment(value: unknown): value is TicketComment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const comment = value as Record<string, unknown>;
  return typeof comment.id === 'string' && (typeof comment.author === 'string' || comment.author === null) &&
    typeof comment.body === 'string' && (typeof comment.createdAt === 'string' || comment.createdAt === null) &&
    (typeof comment.url === 'string' || comment.url === null);
}

function normalizeHandoffState(state: TicketHandoffState, routeOnly: boolean | undefined) {
  state.changeCursor ??= null;
  state.changeCursorSeeded ??= state.changeCursor !== null;
  state.changeFailures ??= 0;
  state.changeLastPolledAt ??= null;
  state.changeState ??= null;
  state.pullRequest ??= null;
  state.pendingPullRequest ??= null;
  state.retiredPullRequests ??= [];
  for (const entry of state.retiredPullRequests) {
    entry.cursor ??= null;
    entry.state ??= null;
    entry.lastPolledAt ??= null;
    entry.failures ??= 0;
    // Rows retired by an older build have no cursor; snapshot once at the head
    // instead of replaying their entire historical conversation on upgrade.
    entry.cursorSeeded ??= entry.cursor !== null;
  }
  state.routeCursorSeeded ??= !routeOnly;
  state.routeGoalHashes ??= [];
  state.quietUntil ??= null;
  state.deferredUpdates ??= [];
  state.deferredFields ??= [];
  state.associationDeferred ??= null;
}

export async function runTicketHandoff(args: {
  port: TicketPort; dispatch: TicketDispatch; store: SQLiteStore; project: string; issue: number; policy: TicketRuntimePolicy;
  /** Injectable clock for deterministic quiet-period recovery tests. */
  clock?: () => number;
}): Promise<TicketRuntimeOutcome> {
  const { port, dispatch, store, project, issue, policy } = args;
  const clock = args.clock ?? Date.now;
  const quietPeriodMs = policy.quietPeriodMs ?? 0;
  if (!Number.isSafeInteger(quietPeriodMs) || quietPeriodMs < 0) throw new Error('invalid ticket quiet period');
  const postMergePollMs = policy.postMergePollMs ?? DEFAULT_TICKET_POST_MERGE_POLL_MS;
  const postMergePollLimit = policy.postMergePollLimit ?? DEFAULT_TICKET_POST_MERGE_POLL_LIMIT;
  if (!Number.isSafeInteger(postMergePollMs) || postMergePollMs < 0) {
    throw new Error('invalid post-merge poll interval');
  }
  if (!Number.isSafeInteger(postMergePollLimit) || postMergePollLimit < 1 || postMergePollLimit > 20) {
    throw new Error('invalid post-merge poll limit');
  }
  if (policy.maxConcurrentSessions !== undefined &&
      (!Number.isSafeInteger(policy.maxConcurrentSessions) || policy.maxConcurrentSessions < 1)) {
    throw new Error('invalid ticket session concurrency limit');
  }
  const requestedBootstrap = (policy.bootstrap ?? [DEFAULT_TICKET_INSTRUCTION])
    .map((entry) => entry.trim()).filter(Boolean);
  if (requestedBootstrap.length === 0 || !['manual', 'autonomous-after-required-checks'].includes(policy.mergePolicy) ||
      (policy.routeOnly && (!policy.trustedAuthors?.length || !policy.ticketUrl))) {
    throw new Error('invalid ticket runtime policy');
  }
  const systemPrompt = policy.systemPrompt?.trim() || TICKET_AGENT_SYSTEM_PROMPT;
  const requestedGoal = policy.goal && policy.goal.trim() ? policy.goal : null;
  // GitHub project ids are case-insensitive. Canonicalize every workflow key so
  // spelling aliases reuse one persisted ticket session and worktree.
  const projectKey = project.toLocaleLowerCase();
  const routeJobId = createHash('sha256').update(`ticket-router:${projectKey}#${issue}`).digest('hex');
  const priorRoute = policy.routeOnly ? store.readTicketHandoff(routeJobId) : null;
  const priorRouteState = priorRoute?.state as unknown as TicketHandoffState | undefined;
  const alreadyAdmitted = priorRouteState?.activationAdmitted === true || priorRouteState?.initialDispatched === true ||
    (typeof priorRouteState?.initialProgress === 'number' && priorRouteState.initialProgress > 0) ||
    (typeof priorRouteState?.sessionId === 'string' && !!priorRouteState.sessionId);
  let activationAdmitted = false;
  if (policy.routeOnly && policy.activationMention && policy.activationPreverified) {
    // Discovery already proved admission under the hard per-pass budget. Persist
    // the same content-free latch so a restart cannot re-gate the issue.
    activationAdmitted = true;
  }
  if (policy.routeOnly && policy.activationMention && !alreadyAdmitted && !policy.activationPreverified) {
    if (!port.hasActivationMention && !port.scanActivationMention) {
      throw new Error('GitHub activation mention check is unavailable');
    }
    // Route retained associations through the same durable, budgeted scan as
    // discovery so they also resume a page cursor, respect the shared time-based
    // budget and never turn an incomplete scan into a negative.
    const outcome = await checkTicketActivation({
      project,
      issue,
      updatedAt: policy.activationUpdatedAt ?? null,
      login: policy.activationMention,
      trustedAuthors: policy.trustedAuthors ?? [],
      excludedAuthors: policy.toolAuthors ?? [],
      store,
      ...(port.scanActivationMention
        ? { scanActivationMention: (request) => port.scanActivationMention!(request) }
        : { hasActivationMention: (request) => port.hasActivationMention!(request) }),
      now: clock,
    });
    if (outcome.status === 'budget') {
      return { jobId: routeJobId, sessionId: null, state: 'deferred', deferred: true, reason: 'activation-budget',
        ...(outcome.retryAt !== null ? { retryAt: new Date(outcome.retryAt).toISOString() } : {}) };
    }
    if (outcome.status === 'incomplete') {
      return { jobId: routeJobId, sessionId: null, state: 'deferred', deferred: true, reason: 'activation-scan' };
    }
    if (outcome.status === 'backoff') {
      return { jobId: routeJobId, sessionId: null, state: 'deferred', deferred: true, reason: 'activation-mention',
        retryAt: new Date(outcome.retryAt).toISOString() };
    }
    if (outcome.status === 'failure') {
      throw new Error(outcome.error);
    }
    if (outcome.status === 'negative') {
      return { jobId: routeJobId, sessionId: null, state: 'deferred', deferred: true, reason: 'activation-mention' };
    }
    activationAdmitted = true;
  }
  let issueData: TicketIssue | null = null;
  let initialReadFailed = false;
  let current: NormalizedTicket;
  let routeCursor: string | null = null;
  let routeSeedFailed = false;
  try {
    if (policy.routeOnly) {
      if (priorRouteState?.routeCursorSeeded) {
        routeCursor = priorRouteState.cursor;
      } else {
        const batch = await port.updates(project, issue, null);
        routeCursor = batch.nextCursor;
      }
      current = routedTicket(project, issue, policy.ticketUrl ?? `https://github.com/${project}/issues/${issue}`,
        policy.autoImplementLabel, policy.toolAuthors);
    } else {
      issueData = await port.read(project, issue);
      current = scrubTicket(normalizeTicket({ ...issueData, project, number: issue, comments: issueData.comments },
        { autoImplementLabel: policy.autoImplementLabel, toolAuthors: policy.toolAuthors }));
    }
  } catch {
    if (policy.routeOnly) routeSeedFailed = true;
    else initialReadFailed = true;
    issueData = null;
    current = policy.routeOnly
      ? routedTicket(project, issue, policy.ticketUrl ?? `https://github.com/${project}/issues/${issue}`,
        policy.autoImplementLabel, policy.toolAuthors)
      : scrubTicket(normalizeTicket({ project, number: issue, title: 'Ticket read unavailable', body: '', labels: [], comments: [] },
        { autoImplementLabel: policy.autoImplementLabel, toolAuthors: policy.toolAuthors }));
  }
  // Routed chats use a stable ticket identity; legacy exact-goal handoffs retain
  // their acceptance-criteria digest for compatibility and recovery.
  const seedGoal = policy.routeOnly ? `Route GitHub ticket ${projectKey}#${issue}` : requestedGoal ?? defaultTicketGoal(current);
  const goalHash = policy.routeOnly
    ? createHash('sha256').update(`route-only:${projectKey}#${issue}`).digest('hex')
    : createHash('sha256').update(seedGoal).digest('hex');
  let jobId = policy.routeOnly ? routeJobId : createHash('sha256').update(`${projectKey}#${issue}\0${goalHash}`).digest('hex');
  const seed: TicketHandoffState = { ticket: current, mergePolicy: policy.mergePolicy,
    cursor: policy.routeOnly ? routeCursor : issueData?.comments.at(-1)?.id ?? null,
    changeCursor: null as string | null, pullRequest: null, pendingPullRequest: null, retiredPullRequests: [],
    routeCursorSeeded: policy.routeOnly ? !routeSeedFailed : true,
    workflow: policy.routeOnly ? 'route-only' : 'goal',
    ...(activationAdmitted || priorRouteState?.activationAdmitted === true ? { activationAdmitted: true } : {}),
    sessionId: null as string | null, initialDispatched: false, initialProgress: 0, state: 'active', terminal: false,
    statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {} as Record<string, string>,
    turns: [], pendingTurn: null, result: null, summary: '', finalStatusBody: '',
    failureStatus: null, deferredUpdates: [], deferredFields: [], quietUntil: null };
  const record = store.getOrCreateTicketHandoff({ id: jobId, project, issue,
    goalHash, goal: seedGoal,
    state: seed as unknown as Record<string, unknown> });
  jobId = record.id;
  if (!policy.routeOnly && requestedGoal && requestedGoal !== record.goal) {
    throw new Error('persisted ticket goal differs from the supplied acceptance criteria; reuse the original goal or start a new ticket');
  }
  const goal = record.goal;
  const observed = record.state as unknown as TicketHandoffState;
  normalizeHandoffState(observed, policy.routeOnly);
  observed.initialProgress ??= observed.initialDispatched ? requestedBootstrap.length : 0;
  const activeOwner = randomUUID();
  const claim = store.tryClaimTicketHandoff(jobId, activeOwner, {
    ...(policy.maxConcurrentSessions ? { maxConcurrency: policy.maxConcurrentSessions } : {}),
    kind: policy.intakeOnly ? 'intake' : 'session',
  });
  if (!claim.acquired) {
    if ('reason' in claim && claim.reason === 'CAPACITY') return deferredOutcome(jobId, observed, 'capacity');
    if ('reason' in claim && claim.reason === 'BUSY') return deferredOutcome(jobId, observed, 'busy');
    throw new Error('ticket pollers use conflicting tickets.max_concurrency values; refusing admission');
  }
  // The read above may predate another worker's final write. Re-read only after
  // the atomic claim so this turn never overwrites newer events or cursors.
  let claimed: ReturnType<SQLiteStore['readTicketHandoff']>;
  try {
    claimed = store.readTicketHandoff(jobId);
  } catch (error) {
    store.releaseTicketHandoff(jobId, activeOwner);
    throw error;
  }
  if (!claimed) {
    store.releaseTicketHandoff(jobId, activeOwner);
    throw new Error('ticket handoff disappeared after its claim');
  }
  const state = claimed.state as unknown as TicketHandoffState;
  normalizeHandoffState(state, policy.routeOnly);
  state.initialProgress ??= state.initialDispatched ? requestedBootstrap.length : 0;
  // A manual policy is a hard deny: config can tighten an active handoff but
  // cannot silently loosen a previously selected manual restriction.
  const tightenedMergePolicy = policy.mergePolicy === 'manual' && state.mergePolicy !== 'manual';
  if (tightenedMergePolicy) state.mergePolicy = 'manual';
  // Owner-CAS: a stale worker that lost its lease cannot overwrite newer state.
  const persistState = () => store.updateTicketHandoff(jobId, state as unknown as Record<string, unknown>, activeOwner);
  const heartbeat = setInterval(() => {
    // A transient database error must not become an unhandled rejection. If
    // renewal keeps failing, the owner-CAS save will fail closed.
    try {
      store.heartbeatTicketHandoff(jobId, activeOwner);
    } catch {
      // Intentionally ignored; ownership is re-checked on every state write.
    }
  }, Math.max(1_000, Math.floor(DEFAULT_TICKET_LEASE_MS / 3)));
  heartbeat.unref?.();
  const stopHeartbeat = () => clearInterval(heartbeat);
  const save = persistState;
  // These pre-dispatch writes happen outside the main try/finally; release the
  // lease explicitly if they fail so a setup error cannot leak ownership.
  try {
    if (activationAdmitted && !state.activationAdmitted) {
      state.activationAdmitted = true;
      persistState();
    }
    if (tightenedMergePolicy) persistState();
    if (policy.routeOnly && !state.routeCursorSeeded) {
      if (routeSeedFailed) {
        // Fail closed: never dispatch from a null cursor, because that would
        // replay every historical event once the transport recovers.
        state.cursor = null;
      } else {
        state.cursor = routeCursor;
        state.routeCursorSeeded = true;
      }
      save();
    }
  } catch (error) {
    stopHeartbeat();
    store.releaseTicketHandoff(jobId, activeOwner);
    throw error;
  }
  const publish = async (turn: StatusTurn, name: StatusName, body: string) => {
    const key = turn.statusKeys[name];
    if (turn.statusIds[key]) return;
    const posted = await port.publishStatus(project, issue, key, safeText(body, 2500));
    turn.statusIds[key] = posted.id;
    save();
  };
  const changeTransitionEvent = (association: { number: number; url: string }, previous: string | null,
    next: string): TicketComment | null => {
    const category = classifyPullRequestTransition(previous, next);
    if (!category) return null;
    const occurredAt = new Date(clock()).toISOString();
    return { id: `pr-state:${association.number}:${previous ?? 'none'}:${next}:${occurredAt}`,
      author: null, body: '', createdAt: occurredAt, url: association.url, source: 'change', category };
  };
  const reconcileChanges = async (): Promise<TicketComment[]> => {
    const updates: TicketComment[] = [];
    // Only PRs already tracked at the start of this turn participate in the
    // round robin; a PR retired right now waits for the next cycle.
    const trackedAtStart = new Set(state.retiredPullRequests.map((entry) => entry.number));
    if (state.pullRequest) {
      const active = state.pullRequest;
      const now = clock();
      const failures = state.changeFailures ?? 0;
      const wait = failures > 0
        ? Math.min(60 * 60 * 1000, Math.max(postMergePollMs, 1_000) * 2 ** Math.min(failures, 8))
        : 0;
      const lastPolled = state.changeLastPolledAt ?? 0;
      const due = !port.changeUpdates || now - lastPolled >= wait;
      let drained = !port.changeUpdates;
      if (due && port.changeUpdates) {
        try {
          if (!state.changeCursorSeeded && (state.changeFailures ?? 0) === 0) {
            // A newly adopted PR starts at the current head. Never replay its
            // pre-association history as if it were new activity. If this seed
            // fails, a later successful read is treated as a normal batch so a
            // merge cannot discard events observed while the seed was unavailable.
            const snapshot = await port.changeUpdates(project, active.number, null);
            state.changeCursor = snapshot.nextCursor;
            state.changeCursorSeeded = true;
          } else {
            const batch = await port.changeUpdates(project, active.number, state.changeCursor);
            const human = humanTicketComments(batch.updates, policy.toolAuthors);
            // Both the events and the advanced cursor are returned to the caller,
            // which persists them in one durable write. Advance only after the
            // batch mapped successfully so a conversion error cannot lose events.
            if (batch.nextCursor !== state.changeCursor) state.changeCursor = batch.nextCursor;
            state.changeCursorSeeded = true;
            updates.push(...human);
          }
          state.changeFailures = 0;
          state.changeLastPolledAt = now;
          state.associationDeferred = null;
          drained = true;
        } catch {
          // Transient transport/API/rate-limit failure: keep the association and
          // its cursor, back off this PR, and never fail the issue turn.
          state.changeFailures = Math.min(failures + 1, 8);
          state.changeLastPolledAt = now;
          state.associationDeferred = 'pull request conversation unavailable; backing off';
        }
      }
      // Drain before verifying: a merge must not discard events that occurred
      // since the prior poll. The cursor is retained on the retired row.
      if (due && drained && port.verifyChange) {
        let association: { number: number; state: string; url: string } | null = null;
        try {
          association = await port.verifyChange(project, active.number);
          state.changeFailures = 0;
          state.changeLastPolledAt = now;
        } catch {
          state.changeFailures = Math.min((state.changeFailures ?? 0) + 1, 8);
          state.changeLastPolledAt = now;
          state.associationDeferred = 'pull request verification unavailable; backing off';
        }
        if (association) {
          if (association.number !== active.number ||
              association.url.toLocaleLowerCase() !== active.url.toLocaleLowerCase()) {
            // Fail closed without discarding the drained batch or advancing the
            // cursor on a mismatched object.
            state.associationDeferred = 'associated pull request no longer matches the ticket session';
          } else if (association.state !== 'OPEN') {
            const transition = changeTransitionEvent(association, state.changeState ?? 'OPEN', association.state);
            if (transition) updates.push(transition);
            retirePullRequest(state, association, state.changeCursor, now);
          } else {
            // A reopened association is real activity too; keep the transition
            // metadata without inventing a comment author.
            if (state.changeState && state.changeState !== 'OPEN') {
              const reopened = changeTransitionEvent(association, state.changeState, 'OPEN');
              if (reopened) updates.push(reopened);
            }
            state.changeState = 'OPEN';
            state.associationDeferred = null;
          }
        }
      }
    }
    if (state.pendingPullRequest) {
      const pending = state.pendingPullRequest;
      if (state.pullRequest && state.pullRequest.number !== pending.number) {
        // A still-open association owns the conversation. Defer adoption until
        // it closes; the current agent turn still completes.
        state.associationDeferred = 'replacement pull request deferred while the previous association is open';
      } else {
        let association: { number: number; state: string; url: string } | null = null;
        let verified = !port.verifyChange;
        if (port.verifyChange) {
          try {
            association = await port.verifyChange(project, pending.number);
            verified = true;
          } catch {
            state.associationDeferred = 'replacement pull request verification unavailable; association unchanged';
          }
        }
        if (verified) {
          if (association && (association.number !== pending.number ||
              association.url.toLocaleLowerCase() !== pending.url.toLocaleLowerCase())) {
            state.pendingPullRequest = null;
            state.associationDeferred = 'agent-reported pull request no longer matches the ticket session';
          } else {
            const adoptable = !association || association.state === 'OPEN';
            state.pendingPullRequest = null;
            if (adoptable) {
              const prior = state.retiredPullRequests.find((entry) => entry.number === pending.number);
              state.retiredPullRequests = state.retiredPullRequests.filter((entry) => entry.number !== pending.number);
              state.pullRequest = pending;
              // Re-adopting a known PR resumes its conversation instead of
              // replaying the entire history from a null cursor. A PR without a
              // retained cursor is seeded at the head on the next poll.
              state.changeCursor = prior?.cursor ?? null;
              state.changeCursorSeeded = prior ? (prior.cursorSeeded ?? prior.cursor !== null) : false;
              state.changeFailures = 0;
              state.changeLastPolledAt = null;
              state.changeState = prior?.state ?? null;
              state.associationDeferred = null;
            }
          }
        }
      }
    }
    if (port.changeUpdates && state.retiredPullRequests.length) {
      const now = clock();
      const due = state.retiredPullRequests
        .filter((entry) => trackedAtStart.has(entry.number))
        .map((entry) => {
          const failures = entry.failures ?? 0;
          const wait = failures > 0
            ? Math.min(60 * 60 * 1000, Math.max(postMergePollMs, 1_000) * 2 ** Math.min(failures, 8))
            : postMergePollMs;
          return { entry, wait, last: entry.lastPolledAt ?? 0 };
        })
        .filter(({ wait, last }) => now - last >= wait)
        .sort((a, b) => a.last - b.last || a.entry.number - b.entry.number)
        .slice(0, postMergePollLimit);
      for (const { entry } of due) {
        try {
          if (!entry.cursorSeeded) {
            // Upgrade migration: snapshot the current head once. Historical
            // activity that predates retention is not replayed as new events.
            const snapshotBatch = await port.changeUpdates(project, entry.number, null);
            entry.cursor = snapshotBatch.nextCursor;
            entry.cursorSeeded = true;
            entry.lastPolledAt = clock();
            entry.failures = 0;
            continue;
          }
          const batch = await port.changeUpdates(project, entry.number, entry.cursor ?? null);
          const human = humanTicketComments(batch.updates, policy.toolAuthors);
          entry.cursor = batch.nextCursor ?? entry.cursor;
          entry.lastPolledAt = clock();
          entry.failures = 0;
          updates.push(...human);
        } catch {
          // Keep the cursor, back off this PR, and let other tracked PRs run.
          entry.failures = (entry.failures ?? 0) + 1;
          entry.lastPolledAt = clock();
        }
      }
    }
    return updates;
  };
  const readUpdates = async () => {
    const batch = await port.updates(project, issue, state.cursor);
    const trusted = policy.trustedAuthors ? new Set(policy.trustedAuthors.map((author) => author.toLocaleLowerCase())) : null;
    // Verified PR state transitions carry no author and no user content; they
    // are router observations and must not be dropped by the author allowlist.
    const isStateTransition = (comment: TicketComment) => comment.category === 'pr-merge' ||
      comment.category === 'pr-closed' || comment.category === 'pr-state-changed';
    const allowed = (comment: TicketComment) => isStateTransition(comment) ||
      !trusted || (comment.author !== null && trusted.has(comment.author.toLocaleLowerCase()));
    const issueUpdates = humanTicketComments(batch.updates, policy.toolAuthors).filter(allowed)
      .map((comment) => ({ ...comment, body: safeText(comment.body), url: comment.url ? safeText(comment.url, 1000) : null,
        source: 'ticket' as const }));
    const changeUpdates = (await reconcileChanges()).filter(allowed)
      .map((comment) => ({ ...comment, body: safeText(comment.body), url: comment.url ? safeText(comment.url, 1000) : null,
        source: 'change' as const }));
    const merged = new Map<string, TicketComment>();
    for (const comment of [...issueUpdates, ...changeUpdates]) merged.set(updateKey(comment), comment);
    const updates = sortTicketUpdates([...merged.values()]);
    if (policy.routeOnly && requestedGoal) {
      const goalKey = createHash('sha256').update(requestedGoal).digest('hex');
      if (!state.routeGoalHashes.includes(goalKey)) {
        updates.push({ id: `goal:${goalKey}`, author: null, body: '', createdAt: null,
          url: policy.ticketUrl ?? null, source: 'operator' });
        state.routeGoalHashes.push(goalKey);
      }
    }
    return { updates, nextCursor: batch.nextCursor ?? state.cursor };
  };
  const deferUpdates = (updates: TicketComment[], changedFields: string[]) => {
    mergeDeferredUpdates(state, policy.routeOnly ? metadataOnlyUpdates(updates) : updates, changedFields);
  };
  /**
   * Gate one automated dispatch start. Every configured bootstrap entry and
   * every follow-up turn (including a turn resumed at a persisted progress
   * offset) passes through this helper. The window is checked first; the
   * durable cooldown is then claimed in one SQLite transaction immediately
   * before the agent dispatch, so competing pollers cannot both start.
   *
   * A claimed cooldown is consumed even if the dispatch then throws. Dispatch
   * errors are ambiguous: the runner may already have started the agent before
   * the failure surfaced, so refunding would let another turn start inside the
   * operator's global interval for an agent that may have acted.
   */
  const admitDispatch = (): { blocked: DeliveryDecision | null } => {
    if (!policy.delivery) return { blocked: null };
    const now = clock();
    const preflight = evaluateDelivery(policy.delivery, now,
      store.readTicketDispatchStart(policy.delivery.cooldownMs));
    if (!preflight.dispatchAllowed) return { blocked: preflight };
    const claim = store.claimTicketDispatchStart({ cooldownMs: policy.delivery.cooldownMs, now });
    if (claim.acquired) return { blocked: null };
    return { blocked: evaluateDelivery(policy.delivery, now, claim.lastStartedAt) };
  };
  if (policy.intakeOnly) {
    // Intake never dispatches and never publishes status: it only moves
    // observable events into the durable quiet-period batch. A busy issue
    // remains owned by its running worker and is retried on a later poll.
    try {
      if (routeSeedFailed || initialReadFailed || !state.initialDispatched || !state.result || state.pendingTurn) {
        return { jobId, sessionId: state.sessionId, state: 'active' };
      }
      const batch = await readUpdates();
      const changed = JSON.stringify(snapshot(current)) !== JSON.stringify(snapshot(state.ticket));
      if (changed || batch.updates.length) {
        deferUpdates(batch.updates, changedTicketFields(current, state.ticket));
        state.ticket = current;
        state.cursor = batch.nextCursor ?? state.cursor;
        state.quietUntil = clock() + quietPeriodMs;
        // One update carries both cursor and event batch, so a crash cannot
        // forward an event that was never recorded or lose a recorded one.
        save();
        return deferredOutcome(jobId, state, 'quiet-period');
      }
      if (batch.nextCursor !== state.cursor) { state.cursor = batch.nextCursor; save(); }
      return { jobId, sessionId: state.sessionId, state: 'active' };
    } catch {
      // Failure to read is not terminal for intake; GitHub remains the source
      // of truth and the next poll retries from the same cursor.
      return { jobId, sessionId: state.sessionId, state: 'active' };
    } finally {
      // Intake returns before the main dispatch try/finally, so release its
      // short-lived claim here.
      stopHeartbeat();
      store.releaseTicketHandoff(jobId, activeOwner);
    }
  }
  const finishStatus = async (turn: StatusTurn) => {
    try { await publish(turn, 'finished', turn.finalStatusBody); return false; } catch { return true; }
  };
  const retryFailureStatus = async () => {
    const failure = state.failureStatus;
    if (!failure || failure.statusIds?.[failure.statusKeys.finished]) return false;
    return finishStatus(failure);
  };
  const pendingTerminal = async (): Promise<TicketRuntimeOutcome> => {
    save();
    const turn = state.pendingTurn ?? { statusKeys: state.statusKeys, statusIds: state.statusIds, finalStatusBody: state.finalStatusBody };
    const pending = turn.finalStatusBody ? await finishStatus(turn) : false;
    if (!state.pendingTurn) { state.statusIds = turn.statusIds; save(); }
    return publicOutcome(jobId, state, pending);
  };

  let deliveryDecision: DeliveryDecision | null = null;
  if (policy.delivery) {
    try {
      deliveryDecision = evaluateDelivery(policy.delivery, clock(),
        store.readTicketDispatchStart(policy.delivery.cooldownMs));
    } catch (error) {
      // A conflicting cooldown configuration fails closed before any provider
      // effect; do not turn it into an agent FAILED outcome.
      stopHeartbeat();
      store.releaseTicketHandoff(jobId, activeOwner);
      throw error;
    }
  }

  try {
    if (deliveryDecision && !deliveryDecision.dispatchAllowed) {
      // Outside an active window: only collect durable, content-free metadata.
      // No status marker, session turn or agent dispatch starts here.
      if (state.initialDispatched && state.result && !state.pendingTurn) {
        try {
          const batch = await readUpdates();
          const changed = JSON.stringify(snapshot(current)) !== JSON.stringify(snapshot(state.ticket));
          if (changed || batch.updates.length) {
            deferUpdates(batch.updates, changedTicketFields(current, state.ticket));
            state.ticket = current;
            state.cursor = batch.nextCursor ?? state.cursor;
            // The per-issue quiet window keeps running independently.
            state.quietUntil = clock() + quietPeriodMs;
            save();
          } else if (batch.nextCursor !== state.cursor) {
            state.cursor = batch.nextCursor;
            save();
          }
        } catch {
          // GitHub remains authoritative; retry from the same durable cursor.
        }
      } else if (!state.initialDispatched) {
        // Persist the minimal routed identity so a new trusted issue is not lost
        // while its first agent turn waits for the window to open.
        state.ticket = current;
        save();
      }
      return deferredOutcome(jobId, state,
        deliveryDecision.reason === 'cooldown' ? 'cooldown' : 'delivery-window', deliveryDecision);
    }
    if (routeSeedFailed) {
      if (!state.initialDispatched && !state.terminal) { state.state = 'active'; state.terminal = false; }
      if (!state.failureStatus) {
        state.failureStatus = { statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {}, finalStatusBody: '' };
      }
      state.failureStatus.finalStatusBody = 'Agent outcome FAILED (route-only): The ticket event cursor could not be read, so no agent was started and historical events were not replayed. Next action: retry issue-orchestrator goal or tickets poll with the same project and issue.';
      save();
      const pending = await finishStatus(state.failureStatus);
      return { jobId, sessionId: state.sessionId, state: 'failed', ...(pending ? { statusPending: true } : {}) };
    }
    if (initialReadFailed) {
      if (!state.initialDispatched && !state.terminal) { state.state = 'active'; state.terminal = false; }
      if (!state.failureStatus) {
        state.failureStatus = { initialRead: true, statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {}, finalStatusBody: '' };
      }
      state.failureStatus.initialRead = true;
      state.failureStatus.finalStatusBody = `Agent outcome FAILED (${state.ticket.mode}): The GitHub ticket could not be read, so no agent was started. Next action: retry issue-orchestrator goal with the same project, issue, and exact acceptance criteria.`;
      save();
      const pending = await finishStatus(state.failureStatus);
      return { jobId, sessionId: state.sessionId, state: 'failed', ...(pending ? { statusPending: true } : {}) };
    }
    if (await retryFailureStatus()) {
      return { jobId, sessionId: state.sessionId, state: 'failed', statusPending: true };
    }
    if (state.failureStatus?.initialRead && !initialReadFailed && !state.initialDispatched) {
      state.ticket = current;
      state.cursor = issueData?.comments.at(-1)?.id ?? null;
      save();
    }
    if ((state.terminal || (state.initialDispatched && state.result)) && !state.pendingTurn) {
      const batch = await readUpdates();
      const updates = batch.updates;
      const changed = JSON.stringify(snapshot(current)) !== JSON.stringify(snapshot(state.ticket));
      // Human-directed tickets are review-only. A later explicit opt-in may
      // begin the initial handoff, but never resumes a fabricated session.
      if (!state.initialDispatched && current.mode === 'auto-implement') {
        state.ticket = current; state.cursor = batch.nextCursor ?? state.cursor;
        state.state = 'active'; state.terminal = false;
        state.statusKeys = { started: randomUUID(), finished: randomUUID() }; state.statusIds = {};
        save();
      } else if (!state.initialDispatched) {
        if (changed || updates.length || batch.nextCursor !== state.cursor) { state.ticket = current; state.cursor = batch.nextCursor ?? state.cursor; save(); }
        return await pendingTerminal();
      }
      if (!state.initialDispatched) {
        // Continue below into the first (real) agent dispatch.
      } else {
        if (current.mode !== 'auto-implement') {
          if (!changed && !updates.length) {
            if (batch.nextCursor !== state.cursor) { state.cursor = batch.nextCursor; save(); }
            return await pendingTerminal();
          }
          const changedFields = changedTicketFields(current, state.ticket);
          deferUpdates(updates, changedFields);
          state.ticket = current; state.cursor = batch.nextCursor ?? state.cursor;
          state.state = 'REVIEW'; state.terminal = true;
          state.statusKeys = { started: randomUUID(), finished: randomUUID() }; state.statusIds = {};
          state.finalStatusBody = 'Agent outcome REVIEW (human-directed): The opt-in label is absent, so no follow-up agent turn was started. Next action: add the configured auto-implementation label to resume this ticket conversation.';
          save();
          const held = { statusKeys: state.statusKeys, statusIds: state.statusIds, finalStatusBody: state.finalStatusBody };
          await publish(held, 'started', 'Ticket update recorded (human-directed); no agent turn started.');
          const pending = await finishStatus(held);
          return publicOutcome(jobId, state, pending);
        }
        const retryBlocked = policy.retryBlocked === true && !changed && !updates.length &&
          state.result?.status === 'BLOCKED' && !!state.sessionId;
        const hasDeferred = (state.deferredUpdates?.length ?? 0) > 0 || (state.deferredFields?.length ?? 0) > 0;
        // A new burst starts (or extends) the durable quiet period. The cursor
        // and event identities are persisted together before returning.
        if (!retryBlocked && quietPeriodMs > 0 && (changed || updates.length)) {
          deferUpdates(updates, changedTicketFields(current, state.ticket));
          state.ticket = current;
          state.cursor = batch.nextCursor ?? state.cursor;
          state.quietUntil = clock() + quietPeriodMs;
          save();
          return deferredOutcome(jobId, state, 'quiet-period');
        }
        if (!retryBlocked && hasDeferred && state.quietUntil && clock() < state.quietUntil) {
          if (batch.nextCursor !== state.cursor) { state.cursor = batch.nextCursor; save(); }
          return deferredOutcome(jobId, state, 'quiet-period');
        }
        if (!changed && !updates.length && !retryBlocked && !hasDeferred) {
          if (batch.nextCursor !== state.cursor) { state.cursor = batch.nextCursor; save(); }
          if (!state.terminal) {
            state.state = state.result.status;
            state.terminal = true;
            state.summary = safeSummary(state.result, policy.summarize);
            const next = `${nextAction(state.result, state.mergePolicy)}${referenceText(state.result, project)}`;
            state.finalStatusBody = `Agent outcome ${displayedStatus(state.result.status)} (${state.ticket.mode}): ${state.summary} ${next}`;
            save();
          }
          return await pendingTerminal();
        }
        const changedFields = retryBlocked ? [] : changedTicketFields(current, state.ticket);
        const turnId = randomUUID();
        deferUpdates(updates, changedFields);
        const allChangedFields = state.deferredFields;
        const updateList = state.deferredUpdates;
        const goalKey = requestedGoal ? createHash('sha256').update(requestedGoal).digest('hex') : null;
        const acceptanceCriteria = goalKey && updateList.some((entry) => entry.id === `goal:${goalKey}`) ? requestedGoal : undefined;
        state.pendingTurn = { id: turnId, message: messageFor(policy, current, goal, state.mergePolicy, 'update', updateList, allChangedFields, acceptanceCriteria), sessionId: state.sessionId,
          ticket: current, cursor: batch.nextCursor ?? state.cursor, changedFields,
          statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {}, statusMode: current.mode,
          ...(retryBlocked ? { operatorRetry: true } : {}),
          dispatched: false, result: null, summary: '', finalStatusBody: '' };
        if (state.result && !state.turns.some((turn) => turn.id === state.pendingTurn?.id)) {
          state.turns.push({ id: `result-before-${turnId}`, result: state.result, summary: state.summary });
        }
        // Ticket context and cursor intent are durable before any external effect.
        state.terminal = false;
        state.deferredUpdates = []; state.deferredFields = []; state.quietUntil = null;
        save();
      }
    }

    if (state.pendingTurn && !state.pendingTurn.dispatched && current.mode !== 'auto-implement') {
      const turn = state.pendingTurn;
      const batch = await readUpdates();
      const updates = batch.updates;
      const priorPayload = parseUpdateMessage(turn.message);
      const changedFields = changedTicketFields(current, turn.ticket);
      const comments = new Map<string, TicketComment>();
      for (const comment of [...state.deferredUpdates, ...priorPayload.updates, ...updates]) comments.set(updateKey(comment), comment);
      state.deferredUpdates = [...comments.values()];
      state.deferredFields = [...new Set([...state.deferredFields, ...priorPayload.changedFields, ...changedFields])];
      state.pendingTurn = null;
      state.ticket = current; state.cursor = batch.nextCursor ?? state.cursor;
      state.state = 'REVIEW'; state.terminal = true;
      state.statusKeys = { started: randomUUID(), finished: randomUUID() }; state.statusIds = {};
      state.finalStatusBody = 'Agent outcome REVIEW (human-directed): The opt-in label is absent, so the pending follow-up was not dispatched. Next action: add the configured auto-implementation label to resume this ticket conversation.';
      save();
      const held = { statusKeys: state.statusKeys, statusIds: state.statusIds, finalStatusBody: state.finalStatusBody };
      await publish(held, 'started', 'Ticket update recorded (human-directed); pending agent follow-up was not dispatched.');
      const pending = await finishStatus(held);
      return publicOutcome(jobId, state, pending);
    }

    if (!state.initialDispatched && state.ticket.mode !== 'auto-implement') {
      const turn = { statusKeys: state.statusKeys, statusIds: state.statusIds, finalStatusBody: '' };
      if (!state.statusIds[state.statusKeys.started]) await publish(turn, 'started', `Ticket review recorded (${state.ticket.mode}); no agent session started.`);
      state.state = 'REVIEW'; state.terminal = true;
      state.finalStatusBody = `Ticket outcome REVIEW (${state.ticket.mode}): No agent was started because the issue lacks the opt-in label. Next action: add the configured auto-implementation label to request an agent run.`;
      save();
      const pending = await finishStatus({ ...turn, finalStatusBody: state.finalStatusBody });
      return publicOutcome(jobId, state, pending);
    }
    if (!state.initialDispatched) {
      const priorTicket = state.ticket;
      const initialTurn = { id: 'initial', statusKeys: state.statusKeys, statusIds: state.statusIds,
        statusMode: state.ticket.mode, finalStatusBody: state.finalStatusBody };
      const goalKey = requestedGoal ? createHash('sha256').update(requestedGoal).digest('hex') : null;
      if (goalKey && !state.routeGoalHashes.includes(goalKey)) {
        state.routeGoalHashes.push(goalKey);
        save();
      }
      const message = messageFor(policy, state.ticket, goal, state.mergePolicy, 'initial', [], [],
        policy.routeOnly && requestedGoal ? requestedGoal : undefined);
      let progress = state.initialProgress ?? 0;
      while (progress < requestedBootstrap.length) {
        // Each configured bootstrap entry is its own automated dispatch start.
        // Re-evaluate the window and claim the cooldown for resumed progress too.
        const admission = admitDispatch();
        if (admission.blocked) {
          state.initialProgress = progress;
          save();
          return deferredOutcome(jobId, state,
            admission.blocked.reason === 'cooldown' ? 'cooldown' : 'delivery-window', admission.blocked);
        }
        if (!state.statusIds[state.statusKeys.started]) {
          // A failure here (or in the dispatch below) leaves the already claimed
          // cooldown consumed: the provider write may have completed and must not
          // reopen the global interval.
          await publish(initialTurn, 'started', `Agent handoff started (${state.ticket.mode}).`);
        }
        // Never refund on a dispatch error: the agent may already have started.
        const response = await dispatch({ handoffId: jobId, sessionId: state.sessionId, bootstrap: systemPrompt, message,
          instruction: requestedBootstrap[progress],
          ...(progress > 0 ? { continueCompleted: true as const, turnId: `initial-${progress}` } : {}) });
        if (!response || typeof response.sessionId !== 'string' || !response.sessionId.trim()) throw new Error('invalid runner session identity');
        if (state.sessionId && response.sessionId !== state.sessionId) {
          throw new Error('runner session identity changed during the ticket bootstrap');
        }
        state.sessionId = response.sessionId;
        save();
        if (!validateResult(response.result, project)) throw new Error('invalid agent result contract');
        state.result = response.result;
        recordPullRequest(state, response.result, project);
        progress += 1;
        state.initialProgress = progress;
        save();
        if (response.result.status !== 'DONE') break;
      }
      state.initialDispatched = true;
      const batch = await readUpdates();
      const updates = batch.updates;
      const changed = JSON.stringify(snapshot(current)) !== JSON.stringify(snapshot(priorTicket));
      if (changed || updates.length) {
        const changedFields = changedTicketFields(current, priorTicket);
        if (quietPeriodMs > 0) {
          deferUpdates(updates, changedFields);
          state.ticket = current;
          state.cursor = batch.nextCursor ?? state.cursor;
          state.quietUntil = clock() + quietPeriodMs;
          if (state.result) state.turns.push({ id: 'initial', result: state.result, summary: state.summary });
          save();
        } else {
          const turnId = randomUUID();
          state.pendingTurn = { id: turnId, message: messageFor(policy, current, goal, state.mergePolicy, 'update', updates, changedFields),
            sessionId: state.sessionId, ticket: current, cursor: batch.nextCursor ?? state.cursor,
            changedFields, statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {}, statusMode: current.mode,
            dispatched: false, result: null, summary: '', finalStatusBody: '' };
          if (state.result) state.turns.push({ id: 'initial', result: state.result, summary: state.summary });
          save();
        }
      } else {
        state.cursor = batch.nextCursor ?? state.cursor;
        state.ticket = current;
      }
      save();
    }

    const turn = state.pendingTurn;
    if (turn) {
      if (turn.dispatched && turn.finalized) {
        const pending = await finishStatus(turn);
        if (!pending) state.pendingTurn = null;
        save();
        return publicOutcome(jobId, state, pending);
      }
      if (!turn.dispatched) {
        const bootstrap = turn.operatorRetry
          ? `${systemPrompt}\nThis is an explicit operator retry after local runner/tooling remediation. Preserve the original exact acceptance criteria and continue this persisted conversation. If OpenCode edit/patch tools are denied, use the isolated shell tool with the host worktree as its workdir and repository-relative paths inside shell commands.`
          : systemPrompt;
        let progress = turn.progress ?? 0;
        while (progress < requestedBootstrap.length) {
          // Every follow-up dispatch, including a resumed progress offset, is a
          // new automated start and must obey the window and global cooldown.
          const admission = admitDispatch();
          if (admission.blocked) {
            turn.progress = progress;
            save();
            return deferredOutcome(jobId, state,
              admission.blocked.reason === 'cooldown' ? 'cooldown' : 'delivery-window', admission.blocked);
          }
          if (!turn.statusIds[turn.statusKeys.started]) {
            // The cooldown claim is already consumed; a provider write failure
            // must not reopen the interval.
            await publish(turn, 'started', `Agent follow-up started (${turn.statusMode}).`);
          }
          // Never refund on a dispatch error: the agent may already have started.
          const response = await dispatch({ handoffId: jobId, sessionId: turn.sessionId, bootstrap, message: turn.message,
            instruction: requestedBootstrap[progress], continueCompleted: true, turnId: turn.id });
          if (!response || response.sessionId !== turn.sessionId || !validateResult(response.result, project)) {
            throw new Error('invalid update dispatch result');
          }
          turn.result = response.result;
          state.result = response.result;
          recordPullRequest(state, response.result, project);
          state.summary = safeSummary(response.result, policy.summarize);
          progress += 1;
          turn.progress = progress;
          save();
          if (response.result.status !== 'DONE') break;
        }
        turn.dispatched = true;
        const next = `${nextAction(turn.result, state.mergePolicy)}${referenceText(turn.result, project)}`;
        turn.summary = state.summary;
        turn.finalStatusBody = `Agent outcome ${displayedStatus(turn.result.status)} (${turn.statusMode}): ${state.summary} ${next}`;
        save();
      }
      state.ticket = turn.ticket; state.cursor = turn.cursor;
      state.deferredUpdates = []; state.deferredFields = []; state.quietUntil = null;
      state.state = turn.result.status; state.terminal = true;
      state.statusKeys = turn.statusKeys; state.statusIds = turn.statusIds;
      state.finalStatusBody = turn.finalStatusBody; turn.finalized = true;
      state.turns.push({ id: turn.id, message: turn.message, result: turn.result, summary: turn.summary, statusKeys: turn.statusKeys });
      save();
      const pending = await finishStatus(turn);
      if (!pending) state.pendingTurn = null;
      save();
      return publicOutcome(jobId, state, pending);
    }

    const initialTurn = { id: 'initial', statusKeys: state.statusKeys, statusIds: state.statusIds, statusMode: state.ticket.mode,
      finalStatusBody: state.finalStatusBody };
    if (!state.result) throw new Error('missing agent result');
    state.summary = safeSummary(state.result, policy.summarize);
    const next = `${nextAction(state.result, state.mergePolicy)}${referenceText(state.result, project)}`;
    state.finalStatusBody = `Agent outcome ${displayedStatus(state.result.status)} (${state.ticket.mode}): ${state.summary} ${next}`;
    state.state = state.result.status; state.terminal = true; save();
    const pending = await finishStatus({ ...initialTurn, finalStatusBody: state.finalStatusBody });
    return publicOutcome(jobId, state, pending);
  } catch {
    if (policy.isCancelled?.()) {
      // SIGTERM/SIGINT is not an agent failure: leave the durable workflow
      // retryable and never publish a FAILED status for operator shutdown.
      try { save(); } catch { /* lease was lost; do not overwrite a newer owner */ }
      return { jobId, sessionId: state.sessionId, state: 'active', interrupted: true };
    }
    const reviewStatusPending = state.state === 'REVIEW' && /^(?:Ticket|Agent) outcome REVIEW\b/.test(state.finalStatusBody);
    if (!reviewStatusPending) { state.state = 'active'; state.terminal = false; }
    save();
    if (!state.failureStatus || state.failureStatus.statusIds?.[state.failureStatus.statusKeys.finished]) {
      state.failureStatus = { statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {}, finalStatusBody: '' };
    }
    state.failureStatus.finalStatusBody = `Agent outcome FAILED (${state.ticket.mode}): The agent run did not produce a validated result. Next action: retry issue-orchestrator goal with the same project, issue, and exact acceptance criteria.`;
    save();
    const pending = await finishStatus(state.failureStatus);
    return { jobId, sessionId: state.sessionId, state: 'failed', ...(pending ? { statusPending: true } : {}) };
  } finally {
    stopHeartbeat();
    store.releaseTicketHandoff(jobId, activeOwner);
  }
}
