import { createHash, randomUUID } from 'node:crypto';
import type { SQLiteStore } from './persistence.js';
import {
  createTicketHandoff, humanTicketComments, normalizeTicket, serializeTicketHandoff,
  sanitizeTicketText, TICKET_AGENT_SYSTEM_PROMPT,
  type NormalizedTicket, type TicketAgentMode, type TicketComment, type TicketMergePolicy,
} from './ticket-handoff.js';
import type { AgentResult, AgentResultStatus } from '../providers/ports.js';
import { validateAgentResult } from '../providers/agent-result.js';
import type { TicketIssue, TicketPort } from '../providers/ticket-port.js';

type TicketSnapshot = Omit<NormalizedTicket, 'updatedAt' | 'comments'>;
type StatusName = 'started' | 'finished';

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
interface TicketHandoffState {
  ticket: NormalizedTicket;
  mergePolicy: TicketMergePolicy;
  cursor: string | null;
  sessionId: string | null;
  initialDispatched: boolean;
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
  /** Present only for a persisted completed-run follow-up. */
  continueCompleted?: true;
  turnId?: string;
}) => Promise<{ sessionId: string; result: unknown }>;

export interface TicketRuntimePolicy {
  goal: string;
  mergePolicy: TicketMergePolicy;
  autoImplementLabel: string;
  toolAuthors?: string[];
  summarize?: (result: AgentResult) => string;
}

export interface TicketRuntimeOutcome {
  jobId: string;
  sessionId: string | null;
  state: 'active' | 'done' | 'blocked' | 'needs-info' | 'review' | 'failed';
  result?: AgentResult;
  summary?: string;
  statusPending?: boolean;
}

function safeText(value: string, max = 12000): string {
  return sanitizeTicketText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
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
    .replace(/[\\`*_{}\[\]()#+.!|]/g, '\\$&');
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
function snapshot(ticket: NormalizedTicket): TicketSnapshot {
  const { updatedAt: _updatedAt, comments: _comments, ...meaningful } = ticket;
  return meaningful;
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
    ...(result ? { result, summary: state.summary } : {}), ...(pending ? { statusPending: true } : {}) };
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

export async function runTicketHandoff(args: {
  port: TicketPort; dispatch: TicketDispatch; store: SQLiteStore; project: string; issue: number; policy: TicketRuntimePolicy;
}): Promise<TicketRuntimeOutcome> {
  const { port, dispatch, store, project, issue, policy } = args;
  if (!policy.goal.trim() || !['manual', 'autonomous-after-required-checks'].includes(policy.mergePolicy)) throw new Error('invalid ticket runtime policy');
  let issueData: TicketIssue | null = null;
  let initialReadFailed = false;
  let current: NormalizedTicket;
  try {
    issueData = await port.read(project, issue);
    current = scrubTicket(normalizeTicket({ ...issueData, project, number: issue, comments: issueData.comments },
      { autoImplementLabel: policy.autoImplementLabel, toolAuthors: policy.toolAuthors }));
  } catch {
    initialReadFailed = true;
    issueData = null;
    current = scrubTicket(normalizeTicket({ project, number: issue, title: 'Ticket read unavailable', body: '', labels: [], comments: [] },
      { autoImplementLabel: policy.autoImplementLabel, toolAuthors: policy.toolAuthors }));
  }
  const goal = policy.goal;
  const goalHash = createHash('sha256').update(goal).digest('hex');
  const jobId = createHash('sha256').update(`${project}#${issue}\0${goalHash}`).digest('hex');
  const seed: TicketHandoffState = { ticket: current, mergePolicy: policy.mergePolicy, cursor: issueData?.comments.at(-1)?.id ?? null,
    sessionId: null as string | null, initialDispatched: false, state: 'active', terminal: false,
    statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {} as Record<string, string>,
    turns: [], pendingTurn: null, result: null, summary: '', finalStatusBody: '',
    failureStatus: null, deferredUpdates: [], deferredFields: [] };
  const record = store.getOrCreateTicketHandoff({ id: jobId, project, issue, goalHash, goal,
    state: seed as unknown as Record<string, unknown> });
  const state = record.state as unknown as TicketHandoffState;
  // A manual policy is a hard deny: config can tighten an active handoff but
  // cannot silently loosen a previously selected manual restriction.
  const tightenedMergePolicy = policy.mergePolicy === 'manual' && state.mergePolicy !== 'manual';
  if (tightenedMergePolicy) state.mergePolicy = 'manual';
  const activeOwner = randomUUID();
  if (!store.claimTicketHandoff(jobId, activeOwner)) throw new Error('ticket handoff is already active in another CLI process');
  const persistState = () => store.updateTicketHandoff(jobId, state as unknown as Record<string, unknown>);
  if (tightenedMergePolicy) persistState();
  const save = persistState;
  const publish = async (turn: StatusTurn, name: StatusName, body: string) => {
    const key = turn.statusKeys[name];
    if (turn.statusIds[key]) return;
    const posted = await port.publishStatus(project, issue, key, safeText(body, 2500));
    turn.statusIds[key] = posted.id;
    save();
  };
  const finishStatus = async (turn: StatusTurn) => {
    try { await publish(turn, 'finished', turn.finalStatusBody); return false; } catch { return true; }
  };
  const retryFailureStatus = async () => {
    const failure = state.failureStatus;
    if (!failure || failure.statusIds?.[failure.statusKeys.finished]) return false;
    return finishStatus(failure);
  };
  const pendingTerminal = async (): Promise<TicketRuntimeOutcome> => {
    const turn = state.pendingTurn ?? { statusKeys: state.statusKeys, statusIds: state.statusIds, finalStatusBody: state.finalStatusBody };
    const pending = turn.finalStatusBody ? await finishStatus(turn) : false;
    if (!state.pendingTurn) { state.statusIds = turn.statusIds; save(); }
    return publicOutcome(jobId, state, pending);
  };

  try {
    if (initialReadFailed) {
      if (!state.initialDispatched && !state.terminal) { state.state = 'active'; state.terminal = false; }
      if (!state.failureStatus) {
        state.failureStatus = { initialRead: true, statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {}, finalStatusBody: '' };
      }
      state.failureStatus.initialRead = true;
      state.failureStatus.finalStatusBody = `Agent outcome FAILED (${state.ticket.mode}): The GitHub ticket could not be read, so no agent was started. Next action: retry /goal with the same project, issue, and exact acceptance criteria.`;
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
      const batch = await port.updates(project, issue, state.cursor);
      const updates = humanTicketComments(batch.updates, policy.toolAuthors).map((c) => ({ ...c, body: safeText(c.body), url: c.url ? safeText(c.url, 1000) : null }));
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
        return pendingTerminal();
      }
      if (!state.initialDispatched) {
        // Continue below into the first (real) agent dispatch.
      } else {
      if (current.mode !== 'auto-implement') {
        if (!changed && !updates.length) {
          if (batch.nextCursor !== state.cursor) { state.cursor = batch.nextCursor; save(); }
          return pendingTerminal();
        }
        const changedFields = changedTicketFields(current, state.ticket);
        const deferred = new Map<string, TicketComment>();
        for (const comment of [...(state.deferredUpdates ?? []), ...updates]) deferred.set(comment.id, comment);
        state.deferredUpdates = [...deferred.values()];
        state.deferredFields = [...new Set([...(state.deferredFields ?? []), ...changedFields])];
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
      if (!changed && !updates.length) {
        if (batch.nextCursor !== state.cursor) { state.cursor = batch.nextCursor; save(); }
        if (!state.terminal) {
          state.state = state.result.status;
          state.terminal = true;
          state.summary = safeSummary(state.result, policy.summarize);
          const next = `${nextAction(state.result, state.mergePolicy)}${referenceText(state.result, project)}`;
          state.finalStatusBody = `Agent outcome ${displayedStatus(state.result.status)} (${state.ticket.mode}): ${state.summary} ${next}`;
          save();
        }
        return pendingTerminal();
      }
      const changedFields = changedTicketFields(current, state.ticket);
      const turnId = randomUUID();
      const deferred = new Map<string, TicketComment>();
      for (const comment of [...(state.deferredUpdates ?? []), ...updates]) deferred.set(comment.id, comment);
      const allChangedFields = [...new Set([...(state.deferredFields ?? []), ...changedFields])];
      state.pendingTurn = { id: turnId, message: updateMessage(current, goal, state.mergePolicy, [...deferred.values()], allChangedFields), sessionId: state.sessionId,
        ticket: current, cursor: batch.nextCursor ?? state.cursor, changedFields,
        statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {}, statusMode: current.mode,
        dispatched: false, result: null, summary: '', finalStatusBody: '' };
      if (state.result && !state.turns.some((turn) => turn.id === state.pendingTurn?.id)) {
        state.turns.push({ id: `result-before-${turnId}`, result: state.result, summary: state.summary });
      }
      // Ticket context and cursor intent are durable before any external effect.
      state.terminal = false;
      state.deferredUpdates = []; state.deferredFields = [];
      save();
      }
    }

    if (state.pendingTurn && !state.pendingTurn.dispatched && current.mode !== 'auto-implement') {
      const turn = state.pendingTurn;
      const batch = await port.updates(project, issue, state.cursor);
      const updates = humanTicketComments(batch.updates, policy.toolAuthors)
        .map((c) => ({ ...c, body: safeText(c.body), url: c.url ? safeText(c.url, 1000) : null }));
      const priorPayload = parseUpdateMessage(turn.message);
      const changedFields = changedTicketFields(current, turn.ticket);
      const comments = new Map<string, TicketComment>();
      for (const comment of [...state.deferredUpdates, ...priorPayload.updates, ...updates]) comments.set(comment.id, comment);
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
      if (!state.statusIds[state.statusKeys.started]) await publish(initialTurn, 'started', `Agent handoff started (${state.ticket.mode}).`);
      const response = await dispatch({ handoffId: jobId, sessionId: state.sessionId, bootstrap: TICKET_AGENT_SYSTEM_PROMPT,
        message: serializeTicketHandoff(handoff(state.ticket, goal, state.mergePolicy, 'initial')) });
      if (!response || typeof response.sessionId !== 'string' || !response.sessionId.trim()) throw new Error('invalid runner session identity');
      state.sessionId = response.sessionId; save();
       if (!validateResult(response.result, project)) throw new Error('invalid agent result contract');
      state.result = response.result; state.initialDispatched = true;
      const batch = await port.updates(project, issue, state.cursor);
      const updates = humanTicketComments(batch.updates, policy.toolAuthors).map((c) => ({ ...c, body: safeText(c.body), url: c.url ? safeText(c.url, 1000) : null }));
      const changed = JSON.stringify(snapshot(current)) !== JSON.stringify(snapshot(priorTicket));
      if (changed || updates.length) {
        const turnId = randomUUID();
        const changedFields = changedTicketFields(current, priorTicket);
        state.pendingTurn = { id: turnId, message: updateMessage(current, goal, state.mergePolicy, updates, changedFields),
          sessionId: state.sessionId, ticket: current, cursor: batch.nextCursor ?? state.cursor,
          changedFields, statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {}, statusMode: current.mode,
          dispatched: false, result: null, summary: '', finalStatusBody: '' };
        if (state.result) state.turns.push({ id: 'initial', result: state.result, summary: state.summary });
        save();
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
      if (!turn.statusIds[turn.statusKeys.started]) await publish(turn, 'started', `Agent follow-up started (${turn.statusMode}).`);
      if (!turn.dispatched) {
        const response = await dispatch({ handoffId: jobId, sessionId: turn.sessionId, bootstrap: TICKET_AGENT_SYSTEM_PROMPT,
          message: turn.message, continueCompleted: true, turnId: turn.id });
         if (!response || response.sessionId !== turn.sessionId || !validateResult(response.result, project)) throw new Error('invalid update dispatch result');
        turn.result = response.result; turn.dispatched = true;
        state.result = response.result; state.summary = safeSummary(response.result, policy.summarize);
        const next = `${nextAction(response.result, state.mergePolicy)}${referenceText(response.result, project)}`;
        turn.summary = state.summary;
        turn.finalStatusBody = `Agent outcome ${displayedStatus(response.result.status)} (${turn.statusMode}): ${state.summary} ${next}`;
        save();
      }
      state.ticket = turn.ticket; state.cursor = turn.cursor;
      state.deferredUpdates = []; state.deferredFields = [];
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
    const reviewStatusPending = state.state === 'REVIEW' && /^(?:Ticket|Agent) outcome REVIEW\b/.test(state.finalStatusBody);
    if (!reviewStatusPending) { state.state = 'active'; state.terminal = false; }
    save();
    if (!state.failureStatus || state.failureStatus.statusIds?.[state.failureStatus.statusKeys.finished]) {
      state.failureStatus = { statusKeys: { started: randomUUID(), finished: randomUUID() }, statusIds: {}, finalStatusBody: '' };
    }
    state.failureStatus.finalStatusBody = `Agent outcome FAILED (${state.ticket.mode}): The agent run did not produce a validated result. Next action: retry /goal with the same project, issue, and exact acceptance criteria.`;
    save();
    const pending = await finishStatus(state.failureStatus);
    return { jobId, sessionId: state.sessionId, state: 'failed', ...(pending ? { statusPending: true } : {}) };
  } finally {
    store.releaseTicketHandoff(jobId, activeOwner);
  }
}
