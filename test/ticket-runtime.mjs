import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteStore } from '../dist/core/persistence.js';
import { repoConfig } from '../dist/core/config.js';
import { createGithubTicketPort } from '../dist/providers/github-ticket.js';
import { runTicketHandoff } from '../dist/core/ticket-runtime.js';
import { normalizeDeliverySchedule } from '../dist/core/delivery-window.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-runtime-'));
const policy = { goal: 'final AC', mergePolicy: 'manual', autoImplementLabel: 'agent:auto-implement' };
const mkIssue = (number, labels = ['agent:auto-implement']) => ({ id: String(number), number, title: 'ticket', body: 'body', author: 'human', labels, state: 'open', url: `https://example.invalid/${number}`, updatedAt: null,
  comments: [{ id: '1', author: 'human', body: 'first', createdAt: '2026-01-01' }] });
const validResult = (status = 'DONE') => ({ status, summary: 'Completed safely', changed_files: [], commands: [], acceptance: [],
  blocked_reason: ['BLOCKED', 'NEEDS_INFO'].includes(status) ? 'Need operator input' : null, evidence_dir: null, verdict: status });

function fixture(number, { onDispatch, failStatus } = {}) {
  const issue = mkIssue(number); let comments = [...issue.comments];
  const statuses = new Map(); const messages = []; let dispatchCount = 0; let statusFail = failStatus ?? 0;
  const port = {
    async read() { return { ...issue, comments }; },
    async updates(_project, _number, cursor) {
      const at = cursor === null ? -1 : comments.findIndex((c) => c.id === cursor);
      const updates = comments.slice(at + 1);
      return { updates, nextCursor: updates.at(-1)?.id ?? cursor };
    },
    async publishStatus(_p, _n, key, body) {
      if (statusFail > 0 && body.startsWith('Agent outcome ')) { statusFail--; throw Error('unavailable'); }
      if (!statuses.has(key)) statuses.set(key, { id: `status-${statuses.size}`, body });
      return { ...statuses.get(key), skipped: false };
    },
  };
  const dispatch = async (input) => {
    messages.push(input); dispatchCount++;
    return onDispatch ? onDispatch(input, dispatchCount, issue) : { sessionId: input.sessionId ?? 'real-session', result: validResult() };
  };
  return { issue, port, dispatch, statuses, messages, get dispatchCount() { return dispatchCount; },
    get comments() { return comments; }, set comments(v) { comments = v; } };
}
const run = (f, store, number, goal = policy.goal) => runTicketHandoff({ port: f.port, dispatch: f.dispatch, store,
  project: 'owner/repo', issue: number, policy: { ...policy, goal } });

try {
  const store = new SQLiteStore(path.join(dir, 'runtime.sqlite3'));
  const base = fixture(5);
  const first = await run(base, store, 5);
  assert.equal(first.state, 'done');
  assert.match([...base.statuses.values()].at(-1).body, /merge manually in GitHub only after project-required checks pass/,
    'manual policy must provide an explicit manual merge next action');
  assert.match([...base.statuses.values()].at(-1).body, /does not assert CI passed/);
  assert.equal(base.messages[0].sessionId, null, 'new dispatch requests a runner-created session');
  assert.equal(base.messages[0].handoffId, first.jobId, 'adapter gets stable recovery identity separately');
  assert.equal(base.messages[0].bootstrap.includes('final AC'), false);
  assert.equal(JSON.parse(base.messages[0].message).finalAcceptanceCriteria, 'final AC');
  assert.equal(JSON.parse(base.messages[0].message).mergePolicy, 'manual');
  assert.equal(JSON.parse(base.messages[0].message).updates[0].body, 'first',
    'initial dispatch includes the already-read human comments');
  const keys = [...base.statuses.keys()];
  assert.equal(keys.length, 2); assert.ok(keys.every((key) => /^[0-9a-f-]{36}$/.test(key)));
  const unread = fixture(48); let reads = 0;
  const read = unread.port.read;
  unread.port.read = async (...args) => { if (reads++ < 2) throw Error('private transport details'); return read(...args); };
  const unreadDb = new SQLiteStore(path.join(dir, 'unread.sqlite3'));
  const unreadOutcome = await run(unread, unreadDb, 48);
  assert.equal(unreadOutcome.state, 'failed'); assert.equal(unread.dispatchCount, 0);
  assert.match([...unread.statuses.values()][0].body, /outcome FAILED.*retry issue-orchestrator goal/);
  assert.doesNotMatch([...unread.statuses.values()][0].body, /private transport details/);
  assert.equal((await run(unread, unreadDb, 48)).state, 'failed');
  assert.equal(unread.statuses.size, 1, 'repeated read failures reuse one terminal status key');
  assert.equal((await run(unread, unreadDb, 48)).state, 'done', 'initial read failure is journaled and retryable');
  assert.equal(unread.dispatchCount, 1);

  const changedAfterReadError = fixture(49);
  const changedAfterReadErrorDb = new SQLiteStore(path.join(dir, 'changed-after-read-error.sqlite3'));
  await run(changedAfterReadError, changedAfterReadErrorDb, 49);
  changedAfterReadError.comments = [...changedAfterReadError.issue.comments,
    { id: '2', author: 'reviewer', body: 'continue after read recovery', createdAt: '2026-02-05' }];
  const successfulRead = changedAfterReadError.port.read;
  let failOnce = true;
  changedAfterReadError.port.read = async (...args) => {
    if (failOnce) { failOnce = false; throw Error('temporary read outage'); }
    return successfulRead(...args);
  };
  assert.equal((await run(changedAfterReadError, changedAfterReadErrorDb, 49)).state, 'failed');
  assert.equal(changedAfterReadError.dispatchCount, 1, 'a read failure must not restart a completed conversation');
  assert.equal((await run(changedAfterReadError, changedAfterReadErrorDb, 49)).state, 'done');
  assert.equal(changedAfterReadError.dispatchCount, 2);
  assert.equal(changedAfterReadError.messages[1].continueCompleted, true);
  assert.equal(JSON.parse(changedAfterReadError.messages[1].message).updates[0].body, 'continue after read recovery');

  const pollFailure = fixture(50);
  const pollFailureDb = new SQLiteStore(path.join(dir, 'poll-failure.sqlite3'));
  const originalUpdates = pollFailure.port.updates;
  let pollFailsOnce = true;
  pollFailure.port.updates = async (...args) => {
    if (pollFailsOnce) { pollFailsOnce = false; throw Error('temporary updates outage'); }
    return originalUpdates(...args);
  };
  assert.equal((await run(pollFailure, pollFailureDb, 50)).state, 'failed');
  assert.equal(pollFailure.dispatchCount, 1, 'the completed agent result is retained across an updates-read failure');
  pollFailure.comments = [...pollFailure.issue.comments,
    { id: '2', author: 'reviewer', body: 'observed after updates outage', createdAt: '2026-02-06' }];
  assert.equal((await run(pollFailure, pollFailureDb, 50)).state, 'done');
  assert.equal(pollFailure.dispatchCount, 2, 'recovery continues the completed session only for the newly observed update');
  assert.equal(pollFailure.messages[1].continueCompleted, true);
  assert.equal(JSON.parse(pollFailure.messages[1].message).updates[0].body, 'observed after updates outage');
  const needsInfo = fixture(53, { onDispatch: (input) => ({ sessionId: input.sessionId ?? 'needs-info-session', result: validResult('NEEDS_INFO') }) });
  const needsInfoDb = new SQLiteStore(path.join(dir, 'needs-info.sqlite3'));
  assert.equal((await run(needsInfo, needsInfoDb, 53)).state, 'needs-info');
  assert.match([...needsInfo.statuses.values()].at(-1).body, /outcome NEEDS_INFO/);

  const unsafeSummary = fixture(54, { onDispatch: (input) => ({
    sessionId: input.sessionId ?? 'unsafe-summary-session',
    result: { ...validResult(), summary: '@everyone [click](https://evil.example) <img src=x>' },
  }) });
  const unsafeSummaryDb = new SQLiteStore(path.join(dir, 'unsafe-summary.sqlite3'));
  await run(unsafeSummary, unsafeSummaryDb, 54);
  const safeComment = [...unsafeSummary.statuses.values()].at(-1).body;
  assert.doesNotMatch(safeComment, /@everyone|https:\/\/evil\.example|<img/,
    'agent summaries must not create mentions, clickable links, or raw HTML in public status comments');
  assert.match(safeComment, /link omitted/);

  const foreignReference = fixture(56, { onDispatch: (input) => ({
    sessionId: input.sessionId ?? 'foreign-reference-session',
    result: { ...validResult(), references: [{ kind: 'pull_request', url: 'https://github.com/other/repo/pull/9' }] },
  }) });
  const foreignReferenceDb = new SQLiteStore(path.join(dir, 'foreign-reference.sqlite3'));
  assert.equal((await run(foreignReference, foreignReferenceDb, 56)).state, 'failed',
    'agent references outside the selected repository are rejected');
  assert.doesNotMatch([...foreignReference.statuses.values()].at(-1).body, /other\/repo/);
  const again = await run(base, store, 5);
  assert.equal(again.jobId, first.jobId); assert.equal(base.dispatchCount, 1, 'terminal retry does not create another handoff');

  // No opt-in label is review-only: no runner session is created and the outcome is repeat-idempotent.
  const human = fixture(50); human.issue.labels = [];
  const humanDb = new SQLiteStore(path.join(dir, 'human.sqlite3'));
  const review = await run(human, humanDb, 50);
  assert.equal(review.state, 'review'); assert.equal(review.sessionId, null); assert.equal(human.dispatchCount, 0);
  assert.match([...human.statuses.values()].at(-1).body, /REVIEW \(human-directed\)/);
  assert.equal((await run(human, humanDb, 50)).state, 'review'); assert.equal(human.dispatchCount, 0);
  human.issue.labels = ['agent:auto-implement'];
  assert.equal((await run(human, humanDb, 50)).state, 'done');
  assert.equal(human.dispatchCount, 1); assert.equal(human.messages[0].sessionId, null);

  const revoked = fixture(51); const revokedDb = new SQLiteStore(path.join(dir, 'revoked.sqlite3'));
  assert.equal((await run(revoked, revokedDb, 51)).state, 'done');
  revoked.issue.labels = [];
  revoked.comments = [...revoked.issue.comments, { id: '2', author: 'human', body: 'hold further work', createdAt: '2026-02-02' }];
  assert.equal((await run(revoked, revokedDb, 51)).state, 'review');
  assert.equal(revoked.dispatchCount, 1, 'removing opt-in never starts a follow-up agent turn');
  assert.match([...revoked.statuses.values()].at(-1).body, /human-directed/);
  revoked.issue.labels = ['agent:auto-implement'];
  assert.equal((await run(revoked, revokedDb, 51)).state, 'done');
  assert.equal(revoked.dispatchCount, 2);
  assert.equal(revoked.messages[1].continueCompleted, true);
  assert.equal(JSON.parse(revoked.messages[1].message).updates[0].body, 'hold further work',
    'human comments deferred while the opt-in label is absent are delivered when opted back in');

  let pausedAttempts = 0;
  const paused = fixture(52, { onDispatch(input, count) {
    if (count === 2 && pausedAttempts++ === 0) throw Error('temporary follow-up failure');
    return { sessionId: input.sessionId ?? 'paused-session', result: validResult() };
  } });
  const pausedDb = new SQLiteStore(path.join(dir, 'paused.sqlite3'));
  await run(paused, pausedDb, 52);
  paused.comments = [...paused.issue.comments, { id: '2', author: 'human', body: 'defer this update', createdAt: '2026-02-03' }];
  assert.equal((await run(paused, pausedDb, 52)).state, 'failed');
  paused.issue.labels = [];
  assert.equal((await run(paused, pausedDb, 52)).state, 'review');
  assert.equal(paused.dispatchCount, 2, 'a pending follow-up is not retried without opt-in');
  paused.issue.labels = ['agent:auto-implement'];
  assert.equal((await run(paused, pausedDb, 52)).state, 'done');
  assert.equal(paused.dispatchCount, 3);
  assert.equal(JSON.parse(paused.messages[2].message).updates[0].body, 'defer this update');

  // An invalid result preserves the actual session and retries initial dispatch on that session.
  let attempt = 0;
  const malformed = fixture(6, { onDispatch: (input) => {
    attempt++;
    return { sessionId: input.sessionId ?? 'actual-session', result: attempt === 1 ? { summary: 'not a contract' } : validResult() };
  } });
  const malformedDb = new SQLiteStore(path.join(dir, 'malformed.sqlite3'));
  const bad = await run(malformed, malformedDb, 6);
  assert.equal(bad.state, 'failed');
  await assert.rejects(run(malformed, malformedDb, 6, 'changed goal'), /active handoff|goal/i);
  const recovered = await run(malformed, malformedDb, 6);
  assert.equal(recovered.state, 'done');
  assert.equal(malformed.messages[1].sessionId, 'actual-session');
  assert.equal(malformed.messages[0].handoffId, malformed.messages[1].handoffId);

  // Agent failures publish a safe terminal status; uncertain writes retry by the same key before redispatch.
  const failedStatus = fixture(12, { failStatus: 1, onDispatch: (_input, count) => {
    if (count === 1) throw Error('sensitive failure ghp_123456789012345678901234 /home/private/log');
    return { sessionId: 'recovered-session', result: validResult() };
  } });
  let failedStatusDb = new SQLiteStore(path.join(dir, 'failed-status.sqlite3'));
  const failure = await run(failedStatus, failedStatusDb, 12);
  assert.equal(failure.state, 'failed'); assert.equal(failure.statusPending, true);
  assert.equal(failedStatus.statuses.size, 1, 'only the start status was persisted before uncertain failure write');
  failedStatusDb.close(); failedStatusDb = new SQLiteStore(path.join(dir, 'failed-status.sqlite3'));
  const afterFailureRetry = await run(failedStatus, failedStatusDb, 12);
  assert.equal(afterFailureRetry.state, 'done');
  assert.equal(failedStatus.dispatchCount, 2);
  assert.equal(failedStatus.statuses.size, 3, 'failed outcome retry and successful terminal outcome are both idempotently recorded');
  const failureBody = [...failedStatus.statuses.values()].find((status) => status.body.includes('outcome FAILED'))?.body;
  assert.ok(failureBody);
  assert.doesNotMatch(failureBody, /ghp_|\/home\/private\/log|sensitive failure/);

  // A changed issue snapshot is a structured follow-up; comments stay in `updates`.
  const changed = fixture(7, { onDispatch: (input, count, issue) => {
    if (count === 1) throw Error('transient');
    if (count < 4) return { sessionId: input.sessionId ?? 'session-7', result: validResult('BLOCKED') };
    return { sessionId: input.sessionId, result: validResult('DONE') };
  } });
  const changedDb = new SQLiteStore(path.join(dir, 'changed.sqlite3'));
  assert.equal((await run(changed, changedDb, 7)).state, 'failed');
  changed.issue.title = 'changed title'; changed.issue.labels = ['agent:auto-implement']; changed.issue.updatedAt = '2026-02-01';
  changed.comments = [...changed.issue.comments, { id: '2', author: 'human', body: 'new comment', createdAt: '2026-02-01' }];
  const blocked = await run(changed, changedDb, 7);
  assert.equal(blocked.state, 'blocked');
  const followup = JSON.parse(changed.messages[2].message);
  assert.equal(followup.kind, 'update'); assert.equal(followup.ticket.title, 'changed title');
  assert.equal(followup.mode, 'auto-implement'); assert.equal(followup.updates[0].body, 'new comment');
  assert.equal((await run(changed, changedDb, 7)).state, 'blocked');
  assert.equal(changed.dispatchCount, 3, 'terminal BLOCKED outcomes do not retry implicitly');
  const blockedSession = blocked.sessionId;
  const retried = await runTicketHandoff({ port: changed.port, dispatch: changed.dispatch, store: changedDb,
    project: 'owner/repo', issue: 7, policy: { ...policy, retryBlocked: true } });
  assert.equal(retried.state, 'done');
  assert.equal(retried.sessionId, blockedSession, 'explicit retry must reuse the persisted OpenCode conversation');
  assert.equal(changed.dispatchCount, 4);
  assert.equal(changed.messages[3].continueCompleted, true);
  assert.match(changed.messages[3].bootstrap, /explicit operator retry/);
  assert.equal(JSON.parse(changed.messages[3].message).finalAcceptanceCriteria, policy.goal,
    'retry preserves the exact original acceptance criteria');

  // Final status retry reuses persisted key and does not dispatch again.
  const retryStatus = fixture(8, { failStatus: 1 });
  let retryDb = new SQLiteStore(path.join(dir, 'status.sqlite3'));
  const pending = await run(retryStatus, retryDb, 8);
  assert.equal(pending.state, 'done'); assert.equal(pending.statusPending, true);
  const retriesBefore = retryStatus.dispatchCount;
  retryDb.close(); retryDb = new SQLiteStore(path.join(dir, 'status.sqlite3'));
  const statusDone = await run(retryStatus, retryDb, 8);
  assert.equal(statusDone.state, 'done'); assert.equal(statusDone.statusPending, undefined);
  assert.equal(retryStatus.dispatchCount, retriesBefore);
  assert.equal(retryStatus.statuses.size, 2, 'the started status and exactly one terminal status are retained');

  // Human activity after completion is a structured continuation on the original session.
  const comment = fixture(9); const commentDb = new SQLiteStore(path.join(dir, 'comment.sqlite3'));
  await run(comment, commentDb, 9);
  comment.comments = [...comment.issue.comments, { id: '2', author: 'reviewer', body: 'Please clarify', createdAt: '2026-02-02' }];
  await run(comment, commentDb, 9);
  const continuation = comment.messages[1];
  assert.equal(continuation.sessionId, 'real-session');
  assert.equal(continuation.continueCompleted, true); assert.ok(continuation.turnId);
  assert.equal(JSON.parse(continuation.message).kind, 'update');
  assert.equal(JSON.parse(continuation.message).updates[0].body, 'Please clarify');
  assert.equal((await run(comment, commentDb, 9)).state, 'done'); assert.equal(comment.dispatchCount, 2);

  // Status/tool comments and updatedAt alone do not redeliver. Cursor state remains durable over reopen.
  const ignore = fixture(10); const ignoreFile = path.join(dir, 'ignore.sqlite3');
  let ignoreDb = new SQLiteStore(ignoreFile);
  await run(ignore, ignoreDb, 10);
  ignore.comments = [...ignore.issue.comments, { id: 'tool-status', author: 'orchestrator-bot', body: '<!-- issue-orchestrator:status -->working', createdAt: '2026-02-03' }];
  ignore.issue.updatedAt = '2026-02-03'; ignoreDb.close(); ignoreDb = new SQLiteStore(ignoreFile);
  await run(ignore, ignoreDb, 10);
  assert.equal(ignore.dispatchCount, 1);
  ignore.issue.title = 'updated title'; ignore.issue.labels = ['agent:auto-implement', 'triage'];
  ignore.issue.state = 'closed';
  await run(ignore, ignoreDb, 10);
  const fieldUpdate = JSON.parse(ignore.messages[1].message);
  assert.equal(fieldUpdate.kind, 'update'); assert.equal(fieldUpdate.ticket.title, 'updated title');
  assert.equal(fieldUpdate.ticket.state, 'closed'); assert.deepEqual(fieldUpdate.ticket.labels, ['agent:auto-implement', 'triage']);

  // Failed delivery reuses the durable message, turn identity, and real session.
  let updateAttempts = 0;
  const retryUpdate = fixture(11, { onDispatch(input, count) {
    if (count === 2) { updateAttempts++; if (updateAttempts === 1) throw Error('temporary'); }
    return { sessionId: input.sessionId ?? 'retry-session', result: validResult() };
  } });
  const retryUpdateDb = new SQLiteStore(path.join(dir, 'retry-update.sqlite3'));
  await run(retryUpdate, retryUpdateDb, 11);
  retryUpdate.comments = [...retryUpdate.issue.comments, { id: '2', author: 'reviewer', body: 'retry me', createdAt: '2026-02-04' }];
  assert.equal((await run(retryUpdate, retryUpdateDb, 11)).state, 'failed');
  assert.equal((await run(retryUpdate, retryUpdateDb, 11)).state, 'done');
  assert.equal(retryUpdate.messages[1].turnId, retryUpdate.messages[2].turnId);
  assert.equal(retryUpdate.messages[1].message, retryUpdate.messages[2].message);
  assert.equal(retryUpdate.messages[1].sessionId, retryUpdate.messages[2].sessionId);
  assert.equal(retryUpdate.dispatchCount, 3);

  let releaseDispatch;
  let dispatchStarted;
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  const held = new Promise((resolve) => { releaseDispatch = resolve; });
  const concurrent = fixture(55, { async onDispatch(input) {
    dispatchStarted();
    await held;
    return { sessionId: input.sessionId ?? 'concurrent-session', result: validResult() };
  } });
  const concurrentDb = new SQLiteStore(path.join(dir, 'concurrent.sqlite3'));
  const activeRun = run(concurrent, concurrentDb, 55);
  await started;
  const concurrentBusy = await run(concurrent, concurrentDb, 55);
  assert.equal(concurrentBusy.state, 'deferred');
  assert.equal(concurrentBusy.reason, 'busy', 'a live same-issue session defers instead of failing');
  releaseDispatch();
  assert.equal((await activeRun).state, 'done');
  assert.equal(concurrent.dispatchCount, 1, 'one active ticket handoff serializes status writes and agent dispatch');
  assert.equal(concurrent.statuses.size, 2);
  // The exclusive lease defers collection, not delivery: an event recorded while
  // another turn was running is read from the unchanged cursor afterwards.
  concurrent.comments = [...concurrent.comments,
    { id: '2', author: 'human', body: 'during the long turn', createdAt: '2026-02-01' }];
  assert.equal((await run(concurrent, concurrentDb, 55)).state, 'done');
  assert.equal(concurrent.dispatchCount, 2);
  assert.deepEqual(JSON.parse(concurrent.messages[1].message).updates.map((event) => event.id), ['2'],
    'events observed during a long turn are collected after the lease is released');

  const runWith = (f, db, number, extra) => runTicketHandoff({ port: f.port, dispatch: f.dispatch, store: db,
    project: 'owner/repo', issue: number, policy: { ...policy, ...extra } });

  // Configured bootstrap messages are separate turns in one session; a question
  // in a later message ends the bootstrap without starting the remaining turns.
  const bootstrap = fixture(14, { onDispatch: (input, count) => ({
    sessionId: input.sessionId ?? 'bootstrap-session', result: { ...validResult(), summary: `turn ${count}` },
  }) });
  const bootstrapDb = new SQLiteStore(path.join(dir, 'bootstrap.sqlite3'));
  const bootstrapOutcome = await runWith(bootstrap, bootstrapDb, 14, {
    bootstrap: ['Plan the change.', 'Implement the change.'],
  });
  assert.equal(bootstrapOutcome.state, 'done');
  assert.equal(bootstrap.dispatchCount, 2, 'each bootstrap entry is dispatched as its own turn');
  assert.equal(bootstrap.messages[0].instruction, 'Plan the change.');
  assert.equal(bootstrap.messages[1].instruction, 'Implement the change.');
  assert.equal(bootstrap.messages[0].sessionId, null);
  assert.equal(bootstrap.messages[1].sessionId, 'bootstrap-session', 'both messages share one runner session');
  assert.equal(bootstrap.messages[1].continueCompleted, true);
  assert.ok(!bootstrap.messages[0].continueCompleted, 'the first bootstrap message starts the session');
  assert.equal(JSON.parse(bootstrap.messages[1].message).finalAcceptanceCriteria, policy.goal);

  const question = fixture(15, { onDispatch: (input, count) => ({
    sessionId: input.sessionId ?? 'question-session',
    result: count === 1 ? validResult() : validResult('NEEDS_INFO'),
  }) });
  const questionDb = new SQLiteStore(path.join(dir, 'question-bootstrap.sqlite3'));
  const questionOutcome = await runWith(question, questionDb, 15, {
    bootstrap: ['Plan the change.', 'Implement the change.'],
  });
  assert.equal(questionOutcome.state, 'needs-info');
  assert.equal(question.dispatchCount, 2, 'a NEEDS_INFO stop keeps the remaining bootstrap messages undispatched');
  assert.equal(question.messages.at(-1).instruction, 'Implement the change.');

  // Only configured trusted authors may trigger turns; tool accounts are filtered
  // by the tool-author list so the bridge never reacts to its own comments.
  const scoped = fixture(16);
  const scopedDb = new SQLiteStore(path.join(dir, 'trusted.sqlite3'));
  await runWith(scoped, scopedDb, 16, { trustedAuthors: ['reisi007'], toolAuthors: ['orchestrator-bot'] });
  scoped.comments = [...scoped.issue.comments,
    { id: '2', author: 'stranger', body: 'please act on me', createdAt: '2026-02-07' }];
  assert.equal((await runWith(scoped, scopedDb, 16, { trustedAuthors: ['reisi007'], toolAuthors: ['orchestrator-bot'] })).state, 'done');
  assert.equal(scoped.dispatchCount, 1, 'comments by non-trusted authors are ignored');
  scoped.comments = [...scoped.issue.comments,
    { id: '3', author: 'orchestrator-bot', body: '<!-- issue-orchestrator:status --> still working', createdAt: '2026-02-08' },
    { id: '4', author: 'reisi007', body: 'trusted reply', createdAt: '2026-02-09' }];
  const trustedFollow = await runWith(scoped, scopedDb, 16, { trustedAuthors: ['reisi007'], toolAuthors: ['orchestrator-bot'] });
  assert.equal(trustedFollow.state, 'done');
  assert.equal(scoped.dispatchCount, 2);
  const trustedPayload = JSON.parse(scoped.messages[1].message);
  assert.deepEqual(trustedPayload.updates.map((entry) => entry.body), ['trusted reply'],
    'tool comments are dropped and only the trusted-author reply is delivered');

  // The router persists event identity and forwards URLs only; the ticket agent
  // reads ticket and PR bodies itself and owns all GitHub writes.
  let routePr = 42;
  const reportedPrs = new Set();
  const route = fixture(17, { onDispatch: (input) => {
    reportedPrs.add(routePr);
    return { sessionId: input.sessionId ?? 'route-session', result: { ...validResult(), references: [
      { kind: 'pull_request', url: `https://github.com/owner/repo/pull/${routePr}` },
    ] } };
  } });
  route.port.read = async () => { throw new Error('route-only mode must not read ticket content'); };
  const prStates = new Map([[42, 'OPEN']]);
  const prEvents = new Map();
  const eventsFor = (number) => prEvents.get(number) ?? [];
  route.port.verifyChange = async (_project, number) => ({ number, state: prStates.get(number) ?? 'OPEN',
    url: `https://github.com/owner/repo/pull/${number}` });
  const changePolls = [];
  route.port.changeUpdates = async (_project, number, cursor) => {
    changePolls.push(number);
    assert.ok(reportedPrs.has(number), 'only a pull request reported by this agent session is polled');
    const events = eventsFor(number).map((entry) => entry.id.includes(':') ? entry
      : { ...entry, id: `issue-comment:${entry.id}` });
    const at = cursor === null ? -1 : events.findIndex((entry) => entry.id === cursor);
    if (cursor !== null && at < 0) throw new Error('stored change cursor is absent');
    const updates = events.slice(at + 1);
    return { updates, nextCursor: updates.at(-1)?.id ?? cursor };
  };
  const routeDbFile = path.join(dir, 'route.sqlite3');
  let routeDb = new SQLiteStore(routeDbFile);
  let routePollLimit = 2;
  const routePolicy = () => ({
    routeOnly: true,
    goal: null,
    ticketUrl: 'https://github.com/owner/repo/issues/17',
    trustedAuthors: ['reisi007'],
    toolAuthors: ['orchestrator-bot'],
    bootstrap: ['Inspect the ticket URL.', 'Continue the ticket work.'],
    // Zero interval makes retired PRs due every turn; the per-turn limit then
    // exercises the fair round-robin deterministically.
    postMergePollMs: 0,
    postMergePollLimit: routePollLimit,
  });
  const routeRun = () => runTicketHandoff({ port: route.port, dispatch: route.dispatch, store: routeDb,
    project: 'owner/repo', issue: 17, policy: { ...policy, ...routePolicy() } });
  const routeInitial = await routeRun();
  assert.equal(routeInitial.state, 'done');
  assert.equal(routeInitial.pullRequest.url, 'https://github.com/owner/repo/pull/42');
  assert.equal(route.dispatchCount, 2, 'configured bootstrap messages are dispatched in order');
  const initialEvent = JSON.parse(route.messages[0].message);
  assert.deepEqual(initialEvent, {
    protocol: 'issue-orchestrator.ticket-event.v1', kind: 'initial', project: 'owner/repo', issue: 17,
    ticketUrl: 'https://github.com/owner/repo/issues/17', changedFields: [], events: [],
    digest: { total: 0, categories: [], firstOccurredAt: null, lastOccurredAt: null },
    note: 'Metadata only: no issue, comment, review, diff or file content is included. Fetch details from GitHub yourself.',
  });
  assert.equal(route.messages[0].message, route.messages[1].message, 'both bootstrap turns carry the same event envelope');
  assert.equal(route.messages[0].instruction, 'Inspect the ticket URL.');
  assert.equal(route.messages[1].instruction, 'Continue the ticket work.');
  assert.doesNotMatch(route.messages[0].message, /ticket body|comment 1|"first"/);

  route.comments = [...route.issue.comments,
    { id: '2', author: 'stranger', body: 'untrusted issue body', createdAt: '2026-02-10', url: 'https://github.com/owner/repo/issues/17#issuecomment-2' },
    { id: '3', author: 'orchestrator-bot', body: 'bot body', createdAt: '2026-02-11', url: 'https://github.com/owner/repo/issues/17#issuecomment-3' },
    { id: '4', author: 'reisi007', body: 'trusted issue comment body', createdAt: '2026-02-12', url: 'https://github.com/owner/repo/issues/17#issuecomment-4' }];
  prEvents.set(42, [
    { id: '100', author: 'stranger', body: 'untrusted PR body', createdAt: '2026-02-13', url: 'https://github.com/owner/repo/pull/42#issuecomment-100' },
    { id: '101', author: 'reisi007', body: 'trusted PR body', createdAt: '2026-02-14', url: 'https://github.com/owner/repo/pull/42#issuecomment-101' },
  ]);
  const routeFollow = await routeRun();
  assert.equal(routeFollow.state, 'done');
  assert.equal(routeFollow.sessionId, 'route-session');
  assert.equal(route.dispatchCount, 4, 'trusted issue and PR events resume the persisted session');
  const routed = JSON.parse(route.messages[2].message);
  assert.equal(routed.protocol, 'issue-orchestrator.ticket-event.v1');
  assert.equal(routed.kind, 'update');
  assert.deepEqual(routed.events.map(({ id, author, url, source, category }) => ({ id, author, url, source, category })), [
    { id: '4', author: 'reisi007', url: 'https://github.com/owner/repo/issues/17#issuecomment-4', source: 'ticket', category: 'issue-comment' },
    { id: 'issue-comment:101', author: 'reisi007', url: 'https://github.com/owner/repo/pull/42#issuecomment-101', source: 'change', category: 'pr-conversation' },
  ]);
  assert.deepEqual(routed.digest.categories.map(({ category, count }) => ({ category, count })), [
    { category: 'issue-comment', count: 1 },
    { category: 'pr-conversation', count: 1 },
  ], 'the digest reports compact per-category counts');
  assert.equal(routed.digest.total, 2);
  assert.equal(route.messages[2].message, route.messages[3].message, 'update bootstrap uses the same event envelope');
  assert.doesNotMatch(route.messages[2].message, /issue comment body|PR body|trusted PR body|untrusted/);
  routeDb.close();
  routeDb = new SQLiteStore(routeDbFile);
  assert.equal((await routeRun()).state, 'done');
  assert.equal(route.dispatchCount, 4, 'persisted issue and PR cursors prevent replay after restart');

  // A merge must first drain everything unread since the previous poll; the
  // cursor then moves to the retained post-merge row instead of being cleared.
  prEvents.set(42, [...eventsFor(42),
    { id: '102', author: 'reisi007', body: 'pre-merge trusted body', createdAt: '2026-02-15',
      url: 'https://github.com/owner/repo/pull/42#issuecomment-102' }]);
  prStates.set(42, 'MERGED');
  const pollsBeforeMerge = changePolls.filter((number) => number === 42).length;
  assert.equal((await routeRun()).state, 'done');
  assert.equal(route.dispatchCount, 6, 'the pre-merge event and the merge transition each start a turn');
  const mergedEnvelope = JSON.parse(route.messages.at(-2).message);
  assert.ok(mergedEnvelope.events.some(({ id }) => id === 'issue-comment:102'), 'an event preceding the merge is not discarded');
  assert.ok(mergedEnvelope.events.some(({ id }) => /^pr-state:42:/.test(id) && id.includes(':MERGED:')),
    'the verified merge is forwarded as compact state metadata');
  assert.deepEqual(mergedEnvelope.digest.categories.map(({ category, count }) => ({ category, count })), [
    { category: 'pr-conversation', count: 1 },
    { category: 'pr-merge', count: 1 },
  ]);
  assert.deepEqual(mergedEnvelope.changedFields, [],
    'a PR comment or merge is never classified as an issue-text change');
  assert.doesNotMatch(route.messages.at(-2).message, /pre-merge trusted body/);
  assert.ok(changePolls.filter((number) => number === 42).length > pollsBeforeMerge, 'the PR is drained before retirement');
  const mergedState = routeDb.readTicketHandoff(routeInitial.jobId).state;
  assert.equal(mergedState.pullRequest, null);
  const mergedTrack = mergedState.retiredPullRequests.find((entry) => entry.number === 42);
  assert.ok(mergedTrack?.cursor, 'the merge cursor is retained, never cleared');
  assert.equal(mergedTrack.state, 'MERGED');

  // Trusted post-merge comments and reviews continue reaching the session;
  // untrusted and tool authors are filtered out.
  prEvents.set(42, [...eventsFor(42),
    { id: '103', author: 'reisi007', body: 'post-merge trusted body', createdAt: '2026-02-16',
      url: 'https://github.com/owner/repo/pull/42#issuecomment-103' },
    { id: 'review:110', author: 'reisi007', body: 'post-merge review body', createdAt: '2026-02-17',
      url: 'https://github.com/owner/repo/pull/42#pullrequestreview-110' },
    { id: 'review-comment:111', author: 'reisi007', body: 'post-merge inline body', createdAt: '2026-02-18',
      url: 'https://github.com/owner/repo/pull/42#discussion_r111' },
    { id: '104', author: 'stranger', body: 'post-merge untrusted body', createdAt: '2026-02-19',
      url: 'https://github.com/owner/repo/pull/42#issuecomment-104' },
    { id: '105', author: 'orchestrator-bot', body: 'post-merge bot body', createdAt: '2026-02-20',
      url: 'https://github.com/owner/repo/pull/42#issuecomment-105' }]);
  route.issue.state = 'closed';
  assert.equal((await routeRun()).state, 'done', 'a closed issue does not stop post-merge routing');
  assert.equal(route.dispatchCount, 8);
  const postMergeEnvelope = JSON.parse(route.messages.at(-2).message);
  assert.deepEqual(postMergeEnvelope.events.map(({ id }) => id),
    ['issue-comment:103', 'review:110', 'review-comment:111'],
    'post-merge conversation, review and inline review events all resume the session');
  assert.deepEqual(postMergeEnvelope.events.map(({ category }) => category),
    ['pr-conversation', 'pr-review', 'pr-review-comment']);
  assert.deepEqual(postMergeEnvelope.digest.categories.map(({ category, count }) => ({ category, count })), [
    { category: 'pr-conversation', count: 1 },
    { category: 'pr-review', count: 1 },
    { category: 'pr-review-comment', count: 1 },
  ]);
  assert.doesNotMatch(route.messages.at(-2).message,
    /post-merge trusted body|post-merge review body|post-merge inline body|post-merge untrusted body|post-merge bot body/);
  assert.equal((await routeRun()).state, 'done');
  assert.equal(route.dispatchCount, 8, 'duplicate polling does not redeliver the retained post-merge event');

  // A later associated PR is adopted while the earlier merged PR stays tracked;
  // the per-cycle limit rotates fairly instead of abandoning the older row.
  routePr = 43;
  prStates.set(43, 'OPEN');
  prEvents.set(43, []);
  route.comments = [...route.comments,
    { id: '5', author: 'reisi007', body: 'new association request', createdAt: '2026-02-19', url: 'https://github.com/owner/repo/issues/17#issuecomment-5' }];
  const newAssociation = await routeRun();
  assert.equal(newAssociation.state, 'done');
  assert.equal(newAssociation.pullRequest?.number, 43, 'a later agent-reported PR replaces the retired active association');
  prEvents.set(43, [{ id: '500', author: 'reisi007', body: 'new PR update', createdAt: '2026-02-20',
    url: 'https://github.com/owner/repo/pull/43#issuecomment-500' }]);
  const newPrPoll = await routeRun();
  assert.equal(newPrPoll.state, 'done');
  assert.ok(changePolls.includes(43), 'the replacement PR is polled');

  // Merging the replacement retires it too; both merged PRs remain tracked.
  prStates.set(43, 'MERGED');
  prEvents.set(43, [...eventsFor(43),
    { id: '501', author: 'reisi007', body: 'pre-merge on 43', createdAt: '2026-02-21',
      url: 'https://github.com/owner/repo/pull/43#issuecomment-501' }]);
  assert.equal((await routeRun()).state, 'done');
  let tracked = routeDb.readTicketHandoff(routeInitial.jobId).state.retiredPullRequests;
  assert.deepEqual(tracked.map((entry) => entry.number).sort((a, b) => a - b), [42, 43],
    'multiple previous PRs are retained, not silently dropped');
  prEvents.set(42, [...eventsFor(42),
    { id: '106', author: 'reisi007', body: 'late 42', createdAt: '2026-02-22',
      url: 'https://github.com/owner/repo/pull/42#issuecomment-106' }]);
  prEvents.set(43, [...eventsFor(43),
    { id: '502', author: 'reisi007', body: 'late 43', createdAt: '2026-02-23',
      url: 'https://github.com/owner/repo/pull/43#issuecomment-502' }]);
  routePollLimit = 1;
  const dispatchBeforeRotation = route.dispatchCount;
  const rotationOne = await routeRun();
  assert.equal(rotationOne.state, 'done');
  const firstPolled = changePolls.at(-1);
  assert.ok([42, 43].includes(firstPolled));
  assert.equal(route.dispatchCount, dispatchBeforeRotation + 2, 'exactly one retired PR is polled per cycle');
  const secondPollResult = await routeRun();
  assert.equal(secondPollResult.state, 'done');
  assert.notEqual(changePolls.at(-1), firstPolled, 'the next cycle polls the other retained PR');
  assert.equal(route.dispatchCount, dispatchBeforeRotation + 4, 'both retained PRs are eventually delivered');
  const lateIds = route.messages.slice(-4).map((message) => JSON.parse(message.message).events.map(({ id }) => id)).flat();
  assert.ok(lateIds.includes('issue-comment:106') && lateIds.includes('issue-comment:502'));
  assert.deepEqual(routeDb.readTicketHandoff(routeInitial.jobId).state.retiredPullRequests
    .map((entry) => entry.number).sort((a, b) => a - b), [42, 43], 'round-robin keeps every old PR tracked');

  // API failure for one retained PR keeps the turn successful and its cursor
  // unchanged; the same event is delivered after recovery.
  const failingUpdates = route.port.changeUpdates;
  let failPr = 43;
  route.port.changeUpdates = async (projectName, number, cursor) => {
    if (number === failPr) throw new Error('rate limited');
    return failingUpdates(projectName, number, cursor);
  };
  prEvents.set(42, [...eventsFor(42),
    { id: '107', author: 'reisi007', body: 'after rate limit', createdAt: '2026-02-24',
      url: 'https://github.com/owner/repo/pull/42#issuecomment-107' }]);
  prEvents.set(43, [...eventsFor(43),
    { id: '108', author: 'reisi007', body: 'failed PR retry', createdAt: '2026-02-25',
      url: 'https://github.com/owner/repo/pull/43#issuecomment-108' }]);
  routePollLimit = 2;
  const beforeFailure = route.dispatchCount;
  assert.equal((await routeRun()).state, 'done', 'a PR read failure does not fail the ticket');
  const afterFailureState = routeDb.readTicketHandoff(routeInitial.jobId).state;
  assert.ok(afterFailureState.retiredPullRequests.find((entry) => entry.number === 43).failures >= 1,
    'the failing PR backs off');
  assert.equal(route.dispatchCount, beforeFailure + 2, 'the healthy PR is still delivered');
  failPr = null;
  // Simulate the per-PR backoff having elapsed so the retry is deterministic.
  const retryRecord = routeDb.readTicketHandoff(routeInitial.jobId);
  const retryState = retryRecord.state;
  const retryTrack = retryState.retiredPullRequests.find((entry) => entry.number === 43);
  retryTrack.failures = 0;
  retryTrack.lastPolledAt = 0;
  routeDb.updateTicketHandoff(retryRecord.id, retryState);
  assert.equal((await routeRun()).state, 'done');
  const recoveredIds = JSON.parse(route.messages.at(-2).message).events.map(({ id }) => id);
  assert.deepEqual(recoveredIds, ['issue-comment:108'], 'the failed PR cursor was not advanced; its event is not lost');
  routeDb.close();

  // A merge drain failure must not retire the association: the cursor and the
  // association stay put, so the next poll can deliver the event and then retire.
  const drain = fixture(30, { onDispatch: (input) => ({ sessionId: input.sessionId ?? 'drain-session',
    result: { ...validResult(), references: [{ kind: 'pull_request', url: 'https://github.com/owner/repo/pull/91' }] } }) });
  const drainDb = new SQLiteStore(path.join(dir, 'drain-failure.sqlite3'));
  const drainPolls = [];
  let drainNow = Date.parse('2026-03-01T00:00:00Z');
  drain.port.verifyChange = async (_project, number) => ({ number, state: 'MERGED',
    url: `https://github.com/owner/repo/pull/${number}` });
  drain.port.changeUpdates = async () => { drainPolls.push('fail'); throw new Error('rate limited'); };
  const drainRun = () => runTicketHandoff({ port: drain.port, dispatch: drain.dispatch, store: drainDb,
    project: 'owner/repo', issue: 30, policy: { ...policy, ...routePolicy(), ticketUrl: 'https://github.com/owner/repo/issues/30' },
    clock: () => drainNow });
  const drainInitial = await drainRun();
  assert.equal(drainInitial.state, 'done');
  assert.equal(drainInitial.pullRequest?.number, 91);
  assert.equal((await drainRun()).state, 'done', 'a merge drain failure does not fail the ticket');
  const heldState = drainDb.readTicketHandoff(drainInitial.jobId).state;
  assert.equal(heldState.pullRequest?.number, 91, 'the association is not retired before its unread events are drained');
  assert.deepEqual(heldState.retiredPullRequests, []);
  drain.port.changeUpdates = async (_project, _number, cursor) => {
    drainPolls.push(cursor);
    if (cursor) return { updates: [], nextCursor: cursor };
    return { updates: [{ id: 'issue-comment:700', author: 'reisi007', body: 'drain me',
      createdAt: '2026-03-01', url: 'https://github.com/owner/repo/pull/91#issuecomment-700' }],
    nextCursor: JSON.stringify({ conversation: 700, review: 0, reviewComment: 0 }) };
  };
  drainNow += 10_000; // past the active-PR failure backoff
  const drainRecovered = await drainRun();
  assert.equal(drainRecovered.state, 'done');
  const drainedEnvelope = JSON.parse(drain.messages.at(-2).message);
  assert.ok(drainedEnvelope.events.some(({ id }) => id === 'issue-comment:700'),
    'the event observed before the failed merge drain is delivered exactly once');
  const drainedState = drainDb.readTicketHandoff(drainInitial.jobId).state;
  assert.equal(drainedState.pullRequest, null);
  assert.equal(drainedState.retiredPullRequests[0].number, 91);
  assert.ok(drainedState.retiredPullRequests[0].cursor, 'the drained cursor is retained for post-merge polling');
  assert.equal((await drainRun()).state, 'done');
  assert.equal(drain.messages.filter((message) => JSON.stringify(message).includes('issue-comment:700')).length, 2,
    'restart/retry does not duplicate the drained event');
  drainDb.close();

  // Legacy retired rows have no cursor. The first post-upgrade poll snapshots
  // the current head and discards historical events instead of replaying them.
  const legacy = fixture(31, { onDispatch: (input) => ({ sessionId: input.sessionId ?? 'legacy-session',
    result: { ...validResult(), references: [{ kind: 'pull_request', url: 'https://github.com/owner/repo/pull/92' }] } }) });
  const legacyDb = new SQLiteStore(path.join(dir, 'legacy-retired.sqlite3'));
  const legacyRun = () => runTicketHandoff({ port: legacy.port, dispatch: legacy.dispatch, store: legacyDb,
    project: 'owner/repo', issue: 31, policy: { ...policy, ...routePolicy(), ticketUrl: 'https://github.com/owner/repo/issues/31' } });
  const legacyInitial = await legacyRun();
  const legacyRecord = legacyDb.readTicketHandoff(legacyInitial.jobId);
  const legacyState = legacyRecord.state;
  legacyState.pullRequest = null;
  legacyState.changeCursor = null;
  legacyState.retiredPullRequests = [{ number: 92, url: 'https://github.com/owner/repo/pull/92' }];
  legacyDb.updateTicketHandoff(legacyRecord.id, legacyState);
  const dispatchesBeforeSeed = legacy.dispatchCount;
  let historical = [{ id: 'issue-comment:800', author: 'reisi007', body: 'historical',
    createdAt: '2026-04-01', url: 'https://github.com/owner/repo/pull/92#issuecomment-800' }];
  let fresh = [];
  legacy.port.changeUpdates = async (_project, _number, cursor) => {
    if (cursor === null) return { updates: historical,
      nextCursor: JSON.stringify({ conversation: 800, review: 0, reviewComment: 0 }) };
    return { updates: fresh, nextCursor: cursor };
  };
  assert.equal((await legacyRun()).state, 'done');
  assert.equal(legacy.dispatchCount, dispatchesBeforeSeed,
    'a legacy retired row snapshots its cursor instead of replaying historical events');
  historical = [];
  fresh = [{ id: 'issue-comment:801', author: 'reisi007', body: 'new after upgrade',
    createdAt: '2026-04-02', url: 'https://github.com/owner/repo/pull/92#issuecomment-801' }];
  assert.equal((await legacyRun()).state, 'done');
  assert.deepEqual(JSON.parse(legacy.messages.at(-2).message).events.map(({ id }) => id), ['issue-comment:801'],
    'only events after the migration snapshot are forwarded');
  legacyDb.close();

  // Cursor seeding is a one-time snapshot. If it cannot be read, fail closed so
  // a later retry seeds at the current head instead of replaying history.
  const activeSeedFixture = fixture(20);
  const activeSeedDb = new SQLiteStore(path.join(dir, 'route-seed.sqlite3'));
  const seedUpdates = activeSeedFixture.port.updates;
  let seedAttempts = 0;
  activeSeedFixture.port.updates = async (...args) => {
    seedAttempts += 1;
    if (seedAttempts === 1) throw new Error('cursor transport unavailable');
    return seedUpdates(...args);
  };
  const activeSeedRun = () => runTicketHandoff({ port: activeSeedFixture.port, dispatch: activeSeedFixture.dispatch, store: activeSeedDb,
    project: 'owner/repo', issue: 20,
    policy: { ...policy, ...routePolicy(), ticketUrl: 'https://github.com/owner/repo/issues/20' } });
  const seedFailure = await activeSeedRun();
  assert.equal(seedFailure.state, 'failed');
  assert.equal(activeSeedFixture.dispatchCount, 0, 'a cursor seeding failure must not dispatch an agent');
  activeSeedFixture.comments = [...activeSeedFixture.issue.comments,
    { id: '2', author: 'reisi007', body: 'historical one', createdAt: '2026-02-01' },
    { id: '3', author: 'reisi007', body: 'historical two', createdAt: '2026-02-02' }];
  const seeded = await activeSeedRun();
  assert.equal(seeded.state, 'done');
  assert.equal(activeSeedFixture.dispatchCount, 2, 'retry seeds at the current head without replaying history');
  assert.deepEqual((await activeSeedRun()).state, 'done');
  assert.equal(activeSeedFixture.dispatchCount, 2, 'no historical event is replayed after seeding');
  activeSeedFixture.comments = [...activeSeedFixture.comments,
    { id: '4', author: 'reisi007', body: 'genuinely new', createdAt: '2026-02-03', url: 'https://github.com/owner/repo/issues/20#issuecomment-4' }];
  assert.equal((await activeSeedRun()).state, 'done');
  assert.equal(activeSeedFixture.dispatchCount, 4);
  assert.deepEqual(JSON.parse(activeSeedFixture.messages[2].message).events.map((entry) => entry.id), ['4']);
  activeSeedDb.close();

  // Goal and route-only handoffs share the issue worktree and must not overlap.
  let releaseGoal;
  let goalStarted;
  const goalStartedPromise = new Promise((resolve) => { goalStarted = resolve; });
  const goalHeld = new Promise((resolve) => { releaseGoal = resolve; });
  const goalFixture = fixture(21, { async onDispatch(input) {
    goalStarted();
    await goalHeld;
    return { sessionId: input.sessionId ?? 'goal-session', result: validResult() };
  } });
  const mixedDb = new SQLiteStore(path.join(dir, 'mixed-workflows.sqlite3'));
  const route21 = fixture(21, { onDispatch: (input) => ({
    sessionId: input.sessionId ?? 'route-21', result: validResult(),
  }) });
  const route21Policy = { ...policy, ...routePolicy(), ticketUrl: 'https://github.com/owner/repo/issues/21' };
  const goalRun = run(goalFixture, mixedDb, 21);
  await goalStartedPromise;
  await assert.rejects(runTicketHandoff({ port: route21.port, dispatch: route21.dispatch, store: mixedDb,
    project: 'owner/repo', issue: 21, policy: route21Policy }), /active handoff/,
  'route-only must not start while a goal handoff holds the same issue');
  releaseGoal();
  assert.equal((await goalRun).state, 'done');

  let releaseRoute;
  let routeStarted;
  const routeStartedPromise = new Promise((resolve) => { routeStarted = resolve; });
  const routeHeld = new Promise((resolve) => { releaseRoute = resolve; });
  const route22 = fixture(22, { async onDispatch(input) {
    routeStarted();
    await routeHeld;
    return { sessionId: input.sessionId ?? 'route-22', result: validResult() };
  } });
  const goal22 = fixture(22);
  const route22Run = runTicketHandoff({ port: route22.port, dispatch: route22.dispatch, store: mixedDb,
    project: 'owner/repo', issue: 22,
    policy: { ...policy, ...routePolicy(), ticketUrl: 'https://github.com/owner/repo/issues/22' } });
  await routeStartedPromise;
  await assert.rejects(run(goal22, mixedDb, 22), /active handoff/,
    'goal must not start while a route-only handoff holds the same issue');
  releaseRoute();
  assert.equal((await route22Run).state, 'done');
  mixedDb.close();

  // Event ids may repeat across GitHub collections; source-qualified keys keep
  // both events, while a deleted comment author never triggers an agent turn.
  const collision = fixture(23, { onDispatch: (input) => ({
    sessionId: input.sessionId ?? 'collision-session', result: { ...validResult(), references: [
      { kind: 'pull_request', url: 'https://github.com/owner/repo/pull/55' },
    ] },
  }) });
  collision.port.verifyChange = async (_project, number) => ({ number, state: 'OPEN',
    url: `https://github.com/owner/repo/pull/${number}` });
  let collisionEvents = [];
  collision.port.changeUpdates = async (_project, _number, cursor) => {
    const at = cursor === null ? -1 : collisionEvents.findIndex((entry) => entry.id === cursor);
    const updates = collisionEvents.slice(at + 1);
    return { updates, nextCursor: updates.at(-1)?.id ?? cursor };
  };
  const collisionDb = new SQLiteStore(path.join(dir, 'event-collision.sqlite3'));
  const collisionPolicy = { ...policy, ...routePolicy(), ticketUrl: 'https://github.com/owner/repo/issues/23' };
  const collisionRun = () => runTicketHandoff({ port: collision.port, dispatch: collision.dispatch, store: collisionDb,
    project: 'owner/repo', issue: 23, policy: collisionPolicy });
  await collisionRun();
  collision.comments = [...collision.comments,
    { id: '700', author: 'reisi007', body: 'same id on the issue', createdAt: '2026-02-10', url: 'https://github.com/owner/repo/issues/23#issuecomment-700' }];
  collisionEvents = [{ id: '700', author: 'reisi007', body: 'same id on the PR', createdAt: '2026-02-11',
    url: 'https://github.com/owner/repo/pull/55#issuecomment-700' }];
  await collisionRun();
  const collisionMessage = JSON.parse(collision.messages.at(-2).message);
  assert.deepEqual(collisionMessage.events.map(({ id, source }) => ({ id, source })), [
    { id: '700', source: 'ticket' },
    { id: '700', source: 'change' },
  ], 'identical raw ids from different event types remain distinct');
  const beforeDeletedAuthor = collision.dispatchCount;
  collision.comments = [...collision.comments,
    { id: '701', author: null, body: 'author account deleted', createdAt: '2026-02-12' }];
  assert.equal((await collisionRun()).state, 'done');
  assert.equal(collision.dispatchCount, beforeDeletedAuthor, 'a null comment author is safely ignored');
  collisionDb.close();

  // Project spelling aliases canonicalize to one job/session and do not create
  // a synthetic project-change turn.
  const alias = fixture(31);
  const aliasDb = new SQLiteStore(path.join(dir, 'project-alias.sqlite3'));
  const aliasPolicy = { ...policy, ...routePolicy(), ticketUrl: 'https://github.com/owner/repo/issues/31' };
  const aliasRun = (project) => runTicketHandoff({ port: alias.port, dispatch: alias.dispatch, store: aliasDb,
    project, issue: 31, policy: aliasPolicy });
  const aliasFirst = await aliasRun('Owner/Repo');
  assert.equal(aliasFirst.state, 'done');
  const aliasDispatches = alias.dispatchCount;
  const aliasSecond = await aliasRun('owner/repo');
  assert.equal(aliasSecond.jobId, aliasFirst.jobId, 'project aliases share one persisted ticket job');
  assert.equal(aliasSecond.sessionId, aliasFirst.sessionId);
  assert.equal(alias.dispatchCount, aliasDispatches, 'a spelling alias is not a ticket-change event');
  aliasDb.close();

  // Same-timestamp events use numeric IDs, not lexicographic string order.
  const numericOrder = fixture(32);
  const numericOrderDb = new SQLiteStore(path.join(dir, 'numeric-order.sqlite3'));
  assert.equal((await run(numericOrder, numericOrderDb, 32)).state, 'done');
  numericOrder.comments = [...numericOrder.comments,
    { id: '10', author: 'human', body: 'ten', createdAt: '2026-06-01' },
    { id: '9', author: 'human', body: 'nine', createdAt: '2026-06-01' }];
  assert.equal((await run(numericOrder, numericOrderDb, 32)).state, 'done');
  assert.deepEqual(JSON.parse(numericOrder.messages.at(-1).message).updates.map((event) => event.id), ['9', '10'],
    'numeric event IDs order 9 before 10 when timestamps tie');
  numericOrderDb.close();

  // Multiple PR references fail association closed but do not fail the turn.
  const multipleRefs = fixture(33, { onDispatch: (input) => ({
    sessionId: input.sessionId ?? 'multiple-refs-session',
    result: { ...validResult(), references: [
      { kind: 'pull_request', url: 'https://github.com/owner/repo/pull/70' },
      { kind: 'pull_request', url: 'https://github.com/owner/repo/pull/71' },
    ] },
  }) });
  const multipleRefsDb = new SQLiteStore(path.join(dir, 'multiple-refs.sqlite3'));
  const multipleOutcome = await run(multipleRefs, multipleRefsDb, 33);
  assert.equal(multipleOutcome.state, 'done');
  assert.equal(multipleOutcome.pullRequest, undefined, 'ambiguous PR references are not associated');
  assert.ok([...multipleRefs.statuses.values()].every((status) => !/outcome FAILED/.test(status.body)));
  multipleRefs.comments = [...multipleRefs.comments,
    { id: '2', author: 'human', body: 'continue after ambiguous refs', createdAt: '2026-06-02' }];
  assert.equal((await run(multipleRefs, multipleRefsDb, 33)).state, 'done');
  assert.equal(multipleRefs.dispatchCount, 2, 'the ticket conversation remains usable');
  multipleRefsDb.close();

  // Transient PR verification failure defers association, not the ticket.
  let transientPr = 80;
  let transientVerifyThrows = false;
  const transient = fixture(34, { onDispatch: (input) => ({
    sessionId: input.sessionId ?? 'transient-pr-session',
    result: { ...validResult(), references: [
      { kind: 'pull_request', url: `https://github.com/owner/repo/pull/${transientPr}` },
    ] },
  }) });
  transient.port.verifyChange = async (_project, number) => {
    if (transientVerifyThrows) throw new Error('temporary verification outage');
    return { number, state: 'OPEN', url: `https://github.com/owner/repo/pull/${number}` };
  };
  const transientDb = new SQLiteStore(path.join(dir, 'transient-pr.sqlite3'));
  assert.equal((await run(transient, transientDb, 34)).state, 'done');
  transientPr = 81;
  transient.comments = [...transient.comments,
    { id: '2', author: 'human', body: 'new association', createdAt: '2026-06-03' }];
  assert.equal((await run(transient, transientDb, 34)).state, 'done');
  transientVerifyThrows = true;
  assert.equal((await run(transient, transientDb, 34)).state, 'done',
    'a transient PR verification failure must not wedge the ticket as FAILED');
  assert.ok([...transient.statuses.values()].every((status) => !/outcome FAILED/.test(status.body)));
  transientDb.close();

  const routeNoTrustDb = new SQLiteStore(path.join(dir, 'route-no-trust.sqlite3'));
  await assert.rejects(runTicketHandoff({ port: route.port, dispatch: route.dispatch,
    store: routeNoTrustDb, project: 'owner/repo', issue: 18,
    policy: { ...policy, ...routePolicy(), trustedAuthors: [] } }), /invalid ticket runtime policy/);
  routeNoTrustDb.close();

  const manualRoute = fixture(19);
  manualRoute.port.read = async () => { throw new Error('manual route must not read ticket content'); };
  const manualRouteDb = new SQLiteStore(path.join(dir, 'manual-route.sqlite3'));
  const manualRouteRun = (acceptanceCriteria) => runTicketHandoff({
    port: manualRoute.port, dispatch: manualRoute.dispatch, store: manualRouteDb,
    project: 'owner/repo', issue: 19,
    policy: { ...policy, ...routePolicy(), ticketUrl: 'https://github.com/owner/repo/issues/19',
      goal: acceptanceCriteria },
  });
  const operatorCriteria = 'Private operator acceptance criteria';
  const manualStart = await manualRouteRun(operatorCriteria);
  assert.equal(manualStart.state, 'done');
  assert.equal(JSON.parse(manualRoute.messages[0].message).acceptanceCriteria, operatorCriteria,
    'goal criteria are forwarded separately from GitHub event data');
  assert.equal((await manualRouteRun(operatorCriteria)).jobId, manualStart.jobId);
  assert.equal(manualRoute.dispatchCount, 2, 'repeating the same operator criteria does not start another turn');
  const revisedCriteria = 'A later private acceptance criterion';
  const revised = await manualRouteRun(revisedCriteria);
  assert.equal(revised.sessionId, manualStart.sessionId, 'changed criteria continue the existing ticket chat');
  assert.equal(manualRoute.dispatchCount, 4);
  const criteriaUpdate = JSON.parse(manualRoute.messages[2].message);
  assert.equal(criteriaUpdate.acceptanceCriteria, revisedCriteria);
  assert.equal(criteriaUpdate.events[0].source, 'operator');
  assert.match(criteriaUpdate.events[0].id, /^goal:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(criteriaUpdate.events[0], 'body'), false);
  manualRouteDb.close();

  // Follow-up bursts are coalesced durably; a restart must not lose the batch
  // or shorten the quiet period measured from the latest observed event.
  const quietDbPath = path.join(dir, 'quiet-period.sqlite3');
  let quietDb = new SQLiteStore(quietDbPath);
  const quiet = fixture(70);
  let quietNow = Date.parse('2026-03-01T00:00:00Z');
  const quietPolicy = { ...policy, quietPeriodMs: 60_000 };
  const quietRun = () => runTicketHandoff({ port: quiet.port, dispatch: quiet.dispatch, store: quietDb,
    project: 'owner/repo', issue: 70, policy: quietPolicy, clock: () => quietNow });
  assert.equal((await quietRun()).state, 'done');
  assert.equal(quiet.dispatchCount, 1);
  quiet.comments = [...quiet.comments,
    { id: '2', author: 'human', body: 'burst one', createdAt: '2026-02-01' },
    { id: '3', author: 'human', body: 'burst two', createdAt: '2026-02-02' }];
  quietNow += 1000;
  const firstQuiet = await quietRun();
  assert.equal(firstQuiet.state, 'deferred');
  assert.equal(firstQuiet.reason, 'quiet-period');
  assert.equal(firstQuiet.pendingEvents, 2);
  assert.equal(quiet.dispatchCount, 1, 'a burst must not dispatch before its quiet period');
  assert.equal((await quietRun()).pendingEvents, 2, 're-observing the same cursor does not duplicate events');
  quiet.comments = [...quiet.comments,
    { id: '4', author: 'human', body: 'burst three', createdAt: '2026-02-03' }];
  quietNow += 30_000;
  const extendedQuiet = await quietRun();
  assert.equal(extendedQuiet.pendingEvents, 3, 'a later event extends the durable batch');
  quietDb.close();
  // Reopen the same database: the event identities and deadline survive a restart.
  quietDb = new SQLiteStore(quietDbPath);
  quietNow += 30_000; // 1_000 ms before the latest event's quiet period elapses
  assert.equal((await quietRun()).state, 'deferred');
  assert.equal(quiet.dispatchCount, 1);
  quietNow += 30_000;
  assert.equal((await quietRun()).state, 'done');
  assert.equal(quiet.dispatchCount, 2, 'the coalesced burst is delivered exactly once');
  assert.deepEqual(JSON.parse(quiet.messages[1].message).updates.map((event) => event.id), ['2', '3', '4'],
    'event order is preserved without truncation');
  quietDb.close();

  // Global admission is durable and DB-wide: two live sessions are admitted,
  // a third issue defers without a dispatch, and a finished session frees a slot.
  const capacityDb = new SQLiteStore(path.join(dir, 'capacity.sqlite3'));
  const hold = (issue) => capacityDb.getOrCreateTicketHandoff({
    id: String(issue).repeat(64).slice(0, 64), project: 'owner/repo', issue, goalHash: String(issue).repeat(64).slice(0, 64),
    goal: `Route GitHub ticket owner/repo#${issue}`, state: { terminal: false, workflow: 'route-only' },
  });
  const heldOne = hold(80);
  const heldTwo = hold(81);
  assert.equal(capacityDb.claimTicketHandoff(heldOne.id, 'capacity-owner-one'), true);
  assert.equal(capacityDb.claimTicketHandoff(heldTwo.id, 'capacity-owner-two'), true);
  const limited = fixture(82);
  const capacityRun = () => runTicketHandoff({ port: limited.port, dispatch: limited.dispatch, store: capacityDb,
    project: 'owner/repo', issue: 82, policy: { ...policy, maxConcurrentSessions: 2 } });
  const capped = await capacityRun();
  assert.equal(capped.state, 'deferred');
  assert.equal(capped.reason, 'capacity');
  assert.equal(limited.dispatchCount, 0, 'the global cap is enforced before an agent session starts');
  capacityDb.releaseTicketHandoff(heldOne.id, 'capacity-owner-one');
  assert.equal((await capacityRun()).state, 'done');
  assert.equal(limited.dispatchCount, 1, 'a freed slot admits the next distinct issue');
  capacityDb.releaseTicketHandoff(heldTwo.id, 'capacity-owner-two');
  capacityDb.close();

  // intake-only observes a burst through the fake GitHub port, persists it with
  // its cursor, and dispatches nothing until a later due run.
  const intake = fixture(72);
  const intakeDb = new SQLiteStore(path.join(dir, 'intake-only.sqlite3'));
  let intakeNow = Date.parse('2026-04-01T00:00:00Z');
  const intakePolicy = { ...policy, quietPeriodMs: 60_000 };
  const intakeRun = (intakeOnly) => runTicketHandoff({ port: intake.port, dispatch: intake.dispatch,
    store: intakeDb, project: 'owner/repo', issue: 72,
    policy: intakeOnly ? { ...intakePolicy, intakeOnly: true } : intakePolicy, clock: () => intakeNow });
  await intakeRun(false);
  assert.equal(intake.dispatchCount, 1);
  intake.comments = [...intake.comments,
    { id: '2', author: 'human', body: 'intake one', createdAt: '2026-04-02' },
    { id: '3', author: 'human', body: 'intake two', createdAt: '2026-04-03' }];
  intakeNow += 1000;
  const intakeOnly = await intakeRun(true);
  assert.equal(intakeOnly.state, 'deferred');
  assert.equal(intakeOnly.reason, 'quiet-period');
  assert.equal(intakeOnly.pendingEvents, 2);
  assert.equal(intake.dispatchCount, 1, 'intake must never dispatch an agent');
  intakeNow += 60_000;
  assert.equal((await intakeRun(false)).state, 'done');
  assert.deepEqual(JSON.parse(intake.messages[1].message).updates.map((event) => event.id), ['2', '3']);
  intakeDb.close();

  // End-to-end fake GitHub API: intake-only advances the real port cursor and
  // persists the burst without dispatch; a later due run forwards it.
  let fakeComments = [{ id: 1, author: 'trusted', createdAt: '2026-05-01T00:00:00Z',
    url: 'https://github.com/owner/repo/issues/9#issuecomment-1' }];
  const fakeDriver = {
    raw() {
      return `${JSON.stringify(fakeComments.map((entry) => ({ id: entry.id, user: { login: entry.author },
        created_at: entry.createdAt, html_url: entry.url })))}\n`;
    },
    json() { throw new Error('unexpected fake GitHub JSON call'); },
    run() { throw new Error('unexpected fake GitHub write'); },
  };
  const fakeGithubPort = {
    ...createGithubTicketPort(fakeDriver),
    async publishStatus(_project, _issue, key) { return { id: `fake-status:${key}`, skipped: true }; },
  };
  const fakeDb = new SQLiteStore(path.join(dir, 'fake-github-intake.sqlite3'));
  let fakeNow = Date.parse('2026-05-01T01:00:00Z');
  let fakeDispatches = 0;
  const fakeDispatch = async (input) => {
    fakeDispatches += 1;
    return { sessionId: input.sessionId ?? 'fake-github-session', result: validResult() };
  };
  const fakePolicy = { mergePolicy: 'manual', autoImplementLabel: 'agent:auto-implement',
    routeOnly: true, ticketUrl: 'https://github.com/owner/repo/issues/9', trustedAuthors: ['trusted'],
    quietPeriodMs: 60_000 };
  const fakeRun = (intakeOnly) => runTicketHandoff({ port: fakeGithubPort, dispatch: fakeDispatch, store: fakeDb,
    project: 'owner/repo', issue: 9, policy: intakeOnly ? { ...fakePolicy, intakeOnly: true } : fakePolicy,
    clock: () => fakeNow });
  assert.equal((await fakeRun(false)).state, 'done');
  assert.equal(fakeDispatches, 1);
  fakeComments = [...fakeComments, { id: 2, author: 'trusted', createdAt: '2026-05-01T01:01:00Z',
    url: 'https://github.com/owner/repo/issues/9#issuecomment-2' }];
  fakeNow += 1000;
  const fakeIntake = await fakeRun(true);
  assert.equal(fakeIntake.state, 'deferred');
  assert.equal(fakeIntake.pendingEvents, 1);
  assert.equal(fakeDispatches, 1, 'real GitHub-port intake-only must not dispatch');
  fakeNow += 60_000;
  assert.equal((await fakeRun(false)).state, 'done');
  assert.equal(fakeDispatches, 2);
  fakeDb.close();

  // Operator shutdown aborts the turn without recording a FAILED outcome.
  let cancelled = false;
  const cancelledFixture = fixture(73, { onDispatch(input, count) {
    if (cancelled) throw new Error('run interrupted by SIGTERM');
    return { sessionId: input.sessionId ?? 'cancel-session', result: validResult() };
  } });
  const cancelledDb = new SQLiteStore(path.join(dir, 'cancelled.sqlite3'));
  const cancelledPolicy = { ...policy, isCancelled: () => cancelled };
  const cancelledRun = () => runTicketHandoff({ port: cancelledFixture.port, dispatch: cancelledFixture.dispatch,
    store: cancelledDb, project: 'owner/repo', issue: 73, policy: cancelledPolicy });
  assert.equal((await cancelledRun()).state, 'done');
  cancelledFixture.comments = [...cancelledFixture.comments,
    { id: '2', author: 'human', body: 'after shutdown', createdAt: '2026-04-04' }];
  cancelled = true;
  const interrupted = await cancelledRun();
  assert.equal(interrupted.state, 'active');
  assert.equal(interrupted.interrupted, true);
  assert.ok([...cancelledFixture.statuses.values()].every((status) => !/outcome FAILED/.test(status.body)),
    'SIGTERM cleanup must not publish a failed agent outcome');
  cancelled = false;
  assert.equal((await cancelledRun()).state, 'done');
  assert.deepEqual(JSON.parse(cancelledFixture.messages.at(-1).message).updates.map((event) => event.id), ['2'],
    'recovery redispatches the durable interrupted turn instead of losing it');
  cancelledDb.close();

  // Distinct issues execute concurrently up to the configured cap; the next
  // issue stays deferred without blocking the two running sessions.
  const parallelDb = new SQLiteStore(path.join(dir, 'parallel-capacity.sqlite3'));
  let parallelActive = 0;
  let parallelMax = 0;
  const parallelReleases = [];
  const parallelGate = () => new Promise((resolve) => {
    parallelActive += 1;
    parallelMax = Math.max(parallelMax, parallelActive);
    parallelReleases.push(() => { parallelActive -= 1; resolve(); });
  });
  const parallelFixture = (issue) => fixture(issue, { onDispatch: async (input) => {
    await parallelGate();
    return { sessionId: input.sessionId ?? `parallel-${issue}`, result: validResult() };
  } });
  const parallelOne = parallelFixture(84);
  const parallelTwo = parallelFixture(85);
  // The third issue is only admitted after a slot frees, so its dispatch is not gated.
  const parallelThree = fixture(86);
  const parallelRun = (item, issue) => runTicketHandoff({ port: item.port, dispatch: item.dispatch,
    store: parallelDb, project: 'owner/repo', issue, policy: { ...policy, maxConcurrentSessions: 2 } });
  const runOne = parallelRun(parallelOne, 84);
  const runTwo = parallelRun(parallelTwo, 85);
  for (let attempt = 0; attempt < 100 && parallelActive < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(parallelMax, 2, 'two distinct issue sessions run in parallel');
  const parallelCapped = await parallelRun(parallelThree, 86);
  assert.equal(parallelCapped.state, 'deferred');
  assert.equal(parallelCapped.reason, 'capacity');
  assert.equal(parallelActive, 2);
  for (const release of parallelReleases.splice(0)) release();
  assert.equal((await runOne).state, 'done');
  assert.equal((await runTwo).state, 'done');
  assert.equal((await parallelRun(parallelThree, 86)).state, 'done');
  parallelDb.close();

  // Delivery windows: a new issue observed outside the window is persisted
  // without dispatching, then starts in the next opening.
  const closedWindow = normalizeDeliverySchedule({
    timezone: 'UTC',
    windows: [{ days: ['mon'], start: '01:00', end: '02:00' }],
  });
  const newIssue = fixture(90);
  const newIssueDb = new SQLiteStore(path.join(dir, 'delivery-new-issue.sqlite3'));
  let newIssueNow = Date.parse('2026-03-02T03:00:00Z'); // Monday, after the window
  const newIssuePolicy = { mergePolicy: 'manual', autoImplementLabel: 'agent:auto-implement',
    routeOnly: true, ticketUrl: 'https://github.com/owner/repo/issues/90',
    trustedAuthors: ['human'], delivery: closedWindow };
  const newIssueRun = () => runTicketHandoff({ port: newIssue.port, dispatch: newIssue.dispatch,
    store: newIssueDb, project: 'owner/repo', issue: 90, policy: newIssuePolicy, clock: () => newIssueNow });
  const heldNew = await newIssueRun();
  assert.equal(heldNew.state, 'deferred');
  assert.equal(heldNew.reason, 'delivery-window');
  assert.equal(heldNew.retryAt, new Date('2026-03-09T01:00:00Z').toISOString());
  assert.equal(newIssue.dispatchCount, 0, 'no agent turn starts outside the window');
  assert.ok(newIssueDb.readTicketHandoff(heldNew.jobId), 'the new trusted issue identity is durable');
  newIssueNow = Date.parse('2026-03-02T01:30:00Z'); // inside the window
  assert.equal((await newIssueRun()).state, 'done');
  assert.equal(newIssue.dispatchCount, 1, 'the held issue starts when the window opens');

  // Outside the window, trusted events are persisted as metadata only; a
  // restart keeps the batch and the next opening delivers it in order.
  const meta = fixture(91);
  const metaPath = path.join(dir, 'delivery-metadata.sqlite3');
  let metaDb = new SQLiteStore(metaPath);
  let metaNow = Date.parse('2026-03-02T01:30:00Z');
  const metaPolicy = { ...newIssuePolicy, ticketUrl: 'https://github.com/owner/repo/issues/91',
    quietPeriodMs: 60_000 };
  const metaRun = () => runTicketHandoff({ port: meta.port, dispatch: meta.dispatch,
    store: metaDb, project: 'owner/repo', issue: 91, policy: metaPolicy, clock: () => metaNow });
  assert.equal((await metaRun()).state, 'done');
  assert.equal(meta.dispatchCount, 1);
  meta.comments = [...meta.comments,
    { id: '2', author: 'human', body: 'secret outside-window body one', createdAt: '2026-03-02T02:30:00Z' },
    { id: '3', author: 'human', body: 'secret outside-window body two', createdAt: '2026-03-02T02:40:00Z' }];
  metaNow = Date.parse('2026-03-02T03:00:00Z');
  const heldBatch = await metaRun();
  assert.equal(heldBatch.state, 'deferred');
  assert.equal(heldBatch.reason, 'delivery-window');
  assert.equal(heldBatch.pendingEvents, 2);
  assert.equal(meta.dispatchCount, 1, 'events outside the window never start a turn');
  const heldMetaState = metaDb.readTicketHandoff(heldBatch.jobId).state;
  assert.deepEqual(heldMetaState.deferredUpdates.map((entry) => entry.id), ['2', '3'],
    'event identity and per-issue order are durable');
  assert.ok(heldMetaState.deferredUpdates.every((entry) => entry.body === ''),
    'the durable pending batch stores no comment content');
  metaDb.close();
  metaDb = new SQLiteStore(metaPath);
  assert.equal((await metaRun()).pendingEvents, 2, 'a restart neither loses nor duplicates the batch');
  assert.equal(meta.dispatchCount, 1);
  metaNow = Date.parse('2026-03-09T01:30:00Z');
  assert.equal((await metaRun()).state, 'done');
  assert.equal(meta.dispatchCount, 2, 'the accumulated batch is delivered at the next opening');
  const delivered = JSON.parse(meta.messages.at(-1).message);
  assert.deepEqual(delivered.events.map((event) => event.id), ['2', '3']);
  assert.deepEqual(delivered.digest.categories.map(({ category, count }) => ({ category, count })),
    [{ category: 'issue-comment', count: 2 }]);
  assert.doesNotMatch(meta.messages.at(-1).message, /outside-window body/);
  metaDb.close();

  // quiet_period_ms=0 still supports intake-only observation; the ticker is
  // what accumulates metadata while a turn runs or a window is closed.
  const zeroQuiet = fixture(92);
  const zeroQuietDb = new SQLiteStore(path.join(dir, 'intake-zero-quiet.sqlite3'));
  let zeroQuietNow = Date.parse('2026-04-01T00:00:00Z');
  const zeroQuietPolicy = { ...metaPolicy, ticketUrl: 'https://github.com/owner/repo/issues/92',
    quietPeriodMs: 0, delivery: undefined };
  const zeroQuietRun = (intakeOnly) => runTicketHandoff({ port: zeroQuiet.port, dispatch: zeroQuiet.dispatch,
    store: zeroQuietDb, project: 'owner/repo', issue: 92,
    policy: intakeOnly ? { ...zeroQuietPolicy, intakeOnly: true } : zeroQuietPolicy,
    clock: () => zeroQuietNow });
  assert.equal((await zeroQuietRun(false)).state, 'done');
  zeroQuiet.comments = [...zeroQuiet.comments,
    { id: '2', author: 'human', body: 'quiet zero intake', createdAt: '2026-04-01T00:01:00Z' }];
  zeroQuietNow += 1000;
  const zeroIntake = await zeroQuietRun(true);
  assert.equal(zeroIntake.state, 'deferred');
  assert.equal(zeroIntake.reason, 'quiet-period');
  assert.equal(zeroIntake.pendingEvents, 1);
  assert.equal(zeroQuiet.dispatchCount, 1, 'quiet=0 intake observes without dispatching');
  assert.equal((await zeroQuietRun(false)).state, 'done');
  assert.deepEqual(JSON.parse(zeroQuiet.messages.at(-1).message).events.map((event) => event.id), ['2'],
    'quiet=0 intake preserves the event for the next turn');
  zeroQuietDb.close();

  // The global cooldown gates the actual start across issues and restarts.
  const cooldownPath = path.join(dir, 'delivery-cooldown.sqlite3');
  let cooldownDb = new SQLiteStore(cooldownPath);
  const cooldownSchedule = normalizeDeliverySchedule({ timezone: 'UTC', windows: [], cooldown_ms: 60_000 });
  assert.equal(cooldownSchedule.windows.length, 0, 'a nonzero cooldown applies in 24/7 mode without windows');
  let cooldownNow = Date.parse('2026-05-01T00:00:00Z');
  const cooldownFixtureA = fixture(93);
  const cooldownFixtureB = fixture(94);
  const cooldownPolicy = { ...metaPolicy, ticketUrl: 'https://github.com/owner/repo/issues/93',
    quietPeriodMs: 0, delivery: cooldownSchedule };
  const cooldownRun = (item, issue) => runTicketHandoff({ port: item.port, dispatch: item.dispatch,
    store: cooldownDb, project: 'owner/repo', issue,
    policy: { ...cooldownPolicy, ticketUrl: `https://github.com/owner/repo/issues/${issue}` },
    clock: () => cooldownNow });
  assert.equal((await cooldownRun(cooldownFixtureA, 93)).state, 'done');
  cooldownNow += 30_000;
  const cooled = await cooldownRun(cooldownFixtureB, 94);
  assert.equal(cooled.state, 'deferred');
  assert.equal(cooled.reason, 'cooldown');
  assert.equal(cooled.retryAt, new Date(Date.parse('2026-05-01T00:01:00Z')).toISOString());
  assert.equal(cooldownFixtureB.dispatchCount, 0, 'the cooldown blocks a second start');
  cooldownDb.close();
  cooldownDb = new SQLiteStore(cooldownPath);
  assert.equal((await cooldownRun(cooldownFixtureB, 94)).reason, 'cooldown',
    'the cooldown anchor survives a restart');
  cooldownNow += 30_000;
  assert.equal((await cooldownRun(cooldownFixtureB, 94)).state, 'done');
  assert.equal(cooldownFixtureB.dispatchCount, 1, 'the next start is admitted exactly at the boundary');
  const mismatched = fixture(95);
  await assert.rejects(runTicketHandoff({ port: mismatched.port, dispatch: mismatched.dispatch,
    store: cooldownDb, project: 'owner/repo', issue: 95,
    policy: { ...cooldownPolicy, ticketUrl: 'https://github.com/owner/repo/issues/95',
      delivery: { timezone: null, windows: [], cooldownMs: 30_000 } },
    clock: () => cooldownNow }), /cooldown must be identical/,
  'a poller with a conflicting cooldown fails closed');
  assert.equal(mismatched.dispatchCount, 0);
  cooldownDb.close();

  // Every bootstrap entry is an automated dispatch start: a multi-message turn
  // stops at the cooldown boundary and resumes at the persisted progress later.
  const gated = fixture(97);
  const gatedDb = new SQLiteStore(path.join(dir, 'delivery-gated-progress.sqlite3'));
  let gatedNow = Date.parse('2026-05-02T00:00:00Z');
  const gatedPolicy = { ...metaPolicy, ticketUrl: 'https://github.com/owner/repo/issues/97',
    quietPeriodMs: 0, delivery: cooldownSchedule, bootstrap: ['first bootstrap turn', 'second bootstrap turn'] };
  const gatedRun = () => runTicketHandoff({ port: gated.port, dispatch: gated.dispatch,
    store: gatedDb, project: 'owner/repo', issue: 97, policy: gatedPolicy, clock: () => gatedNow });
  const gatedInitial = await gatedRun();
  assert.equal(gatedInitial.state, 'deferred');
  assert.equal(gatedInitial.reason, 'cooldown');
  assert.equal(gated.dispatchCount, 1, 'the first bootstrap turn started');
  let gatedState = gatedDb.readTicketHandoff(gatedInitial.jobId).state;
  assert.equal(gatedState.initialProgress, 1, 'the cooldown boundary persists bootstrap progress');
  assert.equal(gatedState.initialDispatched, false);
  gatedNow += 60_000;
  assert.equal((await gatedRun()).state, 'done');
  assert.equal(gated.dispatchCount, 2, 'the resumed bootstrap turn is admitted after the cooldown');
  assert.deepEqual(gated.messages.map((message) => message.instruction),
    ['first bootstrap turn', 'second bootstrap turn']);

  // The same per-dispatch gate applies to a follow-up turn resumed at progress 1.
  gated.comments = [...gated.comments,
    { id: '2', author: 'human', body: 'follow-up burst', createdAt: '2026-05-02T00:01:00Z' }];
  gatedNow += 60_000;
  const gatedFollow = await gatedRun();
  assert.equal(gatedFollow.state, 'deferred');
  assert.equal(gatedFollow.reason, 'cooldown');
  assert.equal(gated.dispatchCount, 3, 'the first follow-up turn started');
  let gatedTurn = gatedDb.readTicketHandoff(gatedInitial.jobId).state.pendingTurn;
  assert.equal(gatedTurn.progress, 1, 'follow-up progress is durable at the boundary');
  assert.equal(gatedTurn.dispatched, false);
  gatedNow += 60_000;
  assert.equal((await gatedRun()).state, 'done');
  assert.equal(gated.dispatchCount, 4, 'the resumed follow-up turn is admitted after the cooldown');
  assert.deepEqual(gated.messages.slice(-2).map((message) => message.instruction),
    ['first bootstrap turn', 'second bootstrap turn']);
  gatedDb.close();

  // A dispatch error is ambiguous: the runner may have started the agent before
  // throwing, so the cooldown claim is consumed and never refunded.
  let launchAttempts = 0;
  const launchFailure = fixture(98, { onDispatch(input) {
    launchAttempts += 1;
    if (launchAttempts === 1) throw new Error('simulated launch failure after the agent started');
    return { sessionId: input.sessionId ?? 'launch-session', result: validResult() };
  } });
  const launchDb = new SQLiteStore(path.join(dir, 'delivery-failed-launch.sqlite3'));
  const launchNow = Date.parse('2026-05-03T00:00:00Z');
  const launchPolicy = { ...metaPolicy, quietPeriodMs: 0, delivery: cooldownSchedule };
  const failedLaunch = await runTicketHandoff({ port: launchFailure.port, dispatch: launchFailure.dispatch,
    store: launchDb, project: 'owner/repo', issue: 98,
    policy: { ...launchPolicy, ticketUrl: 'https://github.com/owner/repo/issues/98' }, clock: () => launchNow });
  assert.equal(failedLaunch.state, 'failed');
  assert.equal(launchFailure.dispatchCount, 1);
  assert.equal(launchDb.readTicketDispatchStart(60_000), launchNow,
    'a start-then-throw dispatch conservatively retains its cooldown claim');
  const afterFailure = fixture(99);
  const afterFailureOutcome = await runTicketHandoff({ port: afterFailure.port, dispatch: afterFailure.dispatch,
    store: launchDb, project: 'owner/repo', issue: 99,
    policy: { ...launchPolicy, ticketUrl: 'https://github.com/owner/repo/issues/99' }, clock: () => launchNow });
  assert.equal(afterFailureOutcome.state, 'deferred');
  assert.equal(afterFailureOutcome.reason, 'cooldown',
    'another issue cannot bypass the interval after an ambiguous launch failure');
  assert.equal(afterFailure.dispatchCount, 0);
  const afterCooldown = await runTicketHandoff({ port: afterFailure.port, dispatch: afterFailure.dispatch,
    store: launchDb, project: 'owner/repo', issue: 99,
    policy: { ...launchPolicy, ticketUrl: 'https://github.com/owner/repo/issues/99' },
    clock: () => launchNow + 60_000 });
  assert.equal(afterCooldown.state, 'done', 'the next start is admitted after the full cooldown');
  assert.equal(afterFailure.dispatchCount, 1);
  launchDb.close();

  // quiet_period_ms=0 must not let a closed delivery window dispatch: events
  // are still collected durably and delivered at the next opening.
  const quietClosed = fixture(100);
  const quietClosedDb = new SQLiteStore(path.join(dir, 'delivery-quiet-zero-closed.sqlite3'));
  let quietClosedNow = Date.parse('2026-05-04T03:00:00Z'); // Monday, after 01:00-02:00
  const quietClosedPolicy = { ...metaPolicy, ticketUrl: 'https://github.com/owner/repo/issues/100',
    quietPeriodMs: 0, delivery: closedWindow, bootstrap: ['only turn'] };
  const quietClosedRun = () => runTicketHandoff({ port: quietClosed.port, dispatch: quietClosed.dispatch,
    store: quietClosedDb, project: 'owner/repo', issue: 100,
    policy: quietClosedPolicy, clock: () => quietClosedNow });
  const quietClosedHeld = await quietClosedRun();
  assert.equal(quietClosedHeld.state, 'deferred');
  assert.equal(quietClosedHeld.reason, 'delivery-window');
  assert.equal(quietClosed.dispatchCount, 0, 'quiet=0 never opens a closed window');
  quietClosedNow = Date.parse('2026-05-04T01:30:00Z');
  assert.equal((await quietClosedRun()).state, 'done');
  assert.equal(quietClosed.dispatchCount, 1);
  quietClosed.comments = [...quietClosed.comments,
    { id: '2', author: 'human', body: 'quiet zero closed window body', createdAt: '2026-05-04T02:30:00Z' }];
  quietClosedNow = Date.parse('2026-05-04T03:00:00Z');
  const quietClosedBatch = await quietClosedRun();
  assert.equal(quietClosedBatch.state, 'deferred');
  assert.equal(quietClosedBatch.reason, 'delivery-window');
  assert.equal(quietClosedBatch.pendingEvents, 1);
  assert.equal(quietClosed.dispatchCount, 1, 'quiet=0 outside a window only collects metadata');
  assert.doesNotMatch(JSON.stringify(quietClosedDb.readTicketHandoff(quietClosedBatch.jobId).state),
    /quiet zero closed window body/, 'the durable pending batch stores no body content');
  quietClosedNow = Date.parse('2026-05-11T01:30:00Z');
  assert.equal((await quietClosedRun()).state, 'done');
  assert.equal(quietClosed.dispatchCount, 2, 'the collected event is delivered at the next opening');
  assert.deepEqual(JSON.parse(quietClosed.messages.at(-1).message).events.map((event) => event.id), ['2']);
  quietClosedDb.close();

  // A newly associated PR is seeded at its current head: pre-association
  // comments/reviews are not replayed, while later events are routed.
  const prSeedFixture = fixture(96, { onDispatch(input) {
    return { sessionId: input.sessionId ?? 'seed-session', result: { ...validResult(),
      references: [{ kind: 'pull_request', url: 'https://github.com/owner/repo/pull/300' }] } };
  } });
  const activePrEvents = [{ id: 'issue-comment:900', author: 'human', body: 'pre-association history',
    createdAt: '2026-06-01T00:00:00Z', url: 'https://github.com/owner/repo/pull/300#issuecomment-900' }];
  let activePrReads = 0;
  let failActivePrReads = false;
  prSeedFixture.port.verifyChange = async (_project, number) => ({ number, state: 'OPEN',
    url: `https://github.com/owner/repo/pull/${number}` });
  prSeedFixture.port.changeUpdates = async (_project, _number, cursor) => {
    activePrReads += 1;
    if (failActivePrReads) throw new Error('simulated rate limit');
    if (cursor === null) return { updates: [...activePrEvents], nextCursor: `c${activePrEvents.length}` };
    const index = Number(cursor.slice(1));
    return { updates: activePrEvents.slice(index), nextCursor: `c${activePrEvents.length}` };
  };
  const prSeedDb = new SQLiteStore(path.join(dir, 'active-pr-backoff.sqlite3'));
  let prSeedNow = Date.parse('2026-06-01T01:00:00Z');
  const prSeedPolicy = { mergePolicy: 'manual', autoImplementLabel: 'agent:auto-implement',
    routeOnly: true, ticketUrl: 'https://github.com/owner/repo/issues/96', trustedAuthors: ['human'],
    postMergePollMs: 60_000, quietPeriodMs: 0 };
  const prSeedRun = () => runTicketHandoff({ port: prSeedFixture.port, dispatch: prSeedFixture.dispatch,
    store: prSeedDb, project: 'owner/repo', issue: 96, policy: prSeedPolicy, clock: () => prSeedNow });
  assert.equal((await prSeedRun()).state, 'done');
  assert.equal(prSeedFixture.dispatchCount, 1);
  assert.ok(activePrReads >= 1, 'the new association is seeded at the PR head in the same turn');
  activePrEvents.push({ id: 'issue-comment:901', author: 'human', body: 'after association',
    createdAt: '2026-06-01T01:01:00Z', url: 'https://github.com/owner/repo/pull/300#issuecomment-901' });
  prSeedNow += 1_000;
  assert.equal((await prSeedRun()).state, 'done');
  assert.equal(prSeedFixture.dispatchCount, 2);
  const activeSeededUpdate = JSON.parse(prSeedFixture.messages.at(-1).message);
  assert.deepEqual(activeSeededUpdate.events.map((event) => event.id), ['issue-comment:901'],
    'pre-association history is not replayed');
  assert.doesNotMatch(prSeedFixture.messages.at(-1).message, /pre-association history/);

  // Active-PR read failures back off exponentially; other issues/turns are not
  // failed and the cursor/event batch is preserved.
  failActivePrReads = true;
  prSeedNow += 60_000;
  const failedActiveRun = await prSeedRun();
  const activeStateAfterFailure = prSeedDb.readTicketHandoff(failedActiveRun.jobId).state;
  assert.equal(activeStateAfterFailure.changeFailures, 1, 'the active-PR read failure is recorded');
  const readsAfterFailure = activePrReads;
  prSeedNow += 30_000;
  await prSeedRun();
  assert.equal(activePrReads, readsAfterFailure, 'an active PR in backoff is not polled again immediately');
  prSeedNow += 120_000;
  failActivePrReads = false;
  activePrEvents.push({ id: 'issue-comment:902', author: 'human', body: 'after backoff',
    createdAt: '2026-06-01T01:10:00Z', url: 'https://github.com/owner/repo/pull/300#issuecomment-902' });
  assert.equal((await prSeedRun()).state, 'done');
  assert.equal(prSeedFixture.dispatchCount, 3);
  assert.deepEqual(JSON.parse(prSeedFixture.messages.at(-1).message).events.map((event) => event.id),
    ['issue-comment:902'], 'the retained cursor resumes after backoff without replay');
  prSeedDb.close();

  const activationFixture = fixture(61);
  activationFixture.port.read = async () => { throw new Error('route-only mode must not read ticket content'); };
  let activationAllowed = false;
  let activationUpdatedAt = '2026-06-01T00:00:00Z';
  let activationChecks = 0;
  const activationTimestamps = [];
  activationFixture.port.hasActivationMention = async (request) => {
    activationChecks++;
    activationTimestamps.push(request.updatedAt);
    return activationAllowed && request.updatedAt === activationUpdatedAt;
  };
  let activationDb = new SQLiteStore(path.join(dir, 'activation.sqlite3'));
  const activationPolicy = { ...policy, routeOnly: true, trustedAuthors: ['human'], toolAuthors: [],
    ticketUrl: 'https://github.com/owner/repo/issues/61', activationMention: 'reisi007-jr',
    bootstrap: ['Start the ticket session.'] };
  const activationRun = (store = activationDb) => runTicketHandoff({ port: activationFixture.port,
    dispatch: activationFixture.dispatch, store, project: 'owner/repo', issue: 61,
    policy: { ...activationPolicy, activationUpdatedAt } });
  const notActivated = await activationRun();
  assert.equal(notActivated.state, 'deferred');
  assert.equal(notActivated.reason, 'activation-mention');
  assert.equal(activationFixture.dispatchCount, 0);
  assert.equal(activationDb.listTicketHandoffs('owner/repo', 10).length, 0,
    'a missing activation mention creates no durable route-only handoff');
  // A late mention updates the issue timestamp; the next poll retries with the
  // new revision instead of trusting a previous negative result.
  activationAllowed = true;
  activationUpdatedAt = '2026-06-02T00:00:00Z';
  const activated = await activationRun();
  assert.equal(activated.state, 'done');
  assert.deepEqual(activationTimestamps, ['2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z'],
    'late activation is rechecked with the updated issue timestamp');
  assert.equal(activationChecks, 2);
  let activationState = activationDb.readTicketHandoff(activated.jobId).state;
  assert.equal(activationState.activationAdmitted, true,
    'the admitted state keeps a content-free permanent activation latch');
  assert.doesNotMatch(JSON.stringify(activationState), /reisi007-jr|Please activate/);
  // Restart/another poller opens the same SQLite file: the durable latch must
  // prevent a second mention check and continue the same session.
  activationDb.close();
  activationDb = new SQLiteStore(path.join(dir, 'activation.sqlite3'));
  activationFixture.port.hasActivationMention = async () => {
    throw new Error('an admitted session must never recheck its activation mention');
  };
  activationUpdatedAt = '2026-06-03T00:00:00Z';
  activationFixture.comments = [...activationFixture.issue.comments,
    { id: '2', author: 'human', body: 'trusted follow-up must never be persisted verbatim', createdAt: '2026-06-03' }];
  assert.equal((await activationRun(activationDb)).state, 'done');
  assert.equal(activationChecks, 2, 'a restart reuses the durable activation latch');
  assert.equal(activationFixture.dispatchCount, 2, 'follow-up events continue on the original route session');
  const activationUpdate = JSON.parse(activationFixture.messages.at(-1).message);
  assert.equal(activationUpdate.kind, 'update');
  assert.ok(activationUpdate.events.every((event) => !('body' in event)));
  assert.doesNotMatch(JSON.stringify(activationUpdate), /trusted follow-up must never be persisted verbatim|reisi007-jr/);
  activationState = activationDb.readTicketHandoff(activated.jobId).state;
  assert.doesNotMatch(JSON.stringify(activationState), /trusted follow-up must never be persisted verbatim|reisi007-jr/);
  activationDb.close();

  // Two pollers opening separate SQLite handles must still admit exactly one
  // bootstrap. The second waits on the durable lease and defers.
  let releaseConcurrentActivation;
  let concurrentActivationStarted;
  const concurrentStarted = new Promise((resolve) => { concurrentActivationStarted = resolve; });
  const concurrentActivation = fixture(62, { async onDispatch(input) {
    concurrentActivationStarted();
    await new Promise((resolve) => { releaseConcurrentActivation = resolve; });
    return { sessionId: input.sessionId ?? 'concurrent-activation-session', result: validResult() };
  } });
  concurrentActivation.port.hasActivationMention = async () => true;
  const concurrentPath = path.join(dir, 'activation-concurrent.sqlite3');
  const concurrentStoreA = new SQLiteStore(concurrentPath);
  const concurrentStoreB = new SQLiteStore(concurrentPath);
  const concurrentPolicy = { ...activationPolicy, ticketUrl: 'https://github.com/owner/repo/issues/62',
    activationUpdatedAt: '2026-07-01T00:00:00Z' };
  const concurrentArgs = (store) => ({ port: concurrentActivation.port, dispatch: concurrentActivation.dispatch,
    store, project: 'owner/repo', issue: 62, policy: concurrentPolicy });
  const firstPoller = runTicketHandoff(concurrentArgs(concurrentStoreA));
  await concurrentStarted;
  const secondPoller = await runTicketHandoff(concurrentArgs(concurrentStoreB));
  assert.equal(secondPoller.state, 'deferred');
  assert.equal(secondPoller.reason, 'busy', 'a concurrent poller cannot start a second bootstrap');
  releaseConcurrentActivation();
  const firstOutcome = await firstPoller;
  assert.equal(firstOutcome.state, 'done');
  assert.equal(secondPoller.jobId, firstOutcome.jobId, 'both pollers share one durable route job');
  assert.equal(concurrentActivation.dispatchCount, 1, 'concurrent pollers admit exactly one bootstrap');
  assert.equal(concurrentStoreB.readTicketHandoff(firstOutcome.jobId).state.activationAdmitted, true,
    'the activation latch is durable for the next poller');
  concurrentStoreA.close();
  concurrentStoreB.close();

  const ticketDefaults = repoConfig({ __file: 'test-config', model: 'provider/model',
    repos: { 'owner/repo': {} } }, 'owner/repo');
  assert.equal(ticketDefaults.tickets.max_concurrency, 1);
  assert.equal(ticketDefaults.tickets.activation_mention, undefined, 'activation mention is absent by default');
  assert.equal(ticketDefaults.tickets.quiet_period_ms, 60_000);
  assert.equal(ticketDefaults.tickets.intake_poll_ms, 30_000);
  const ticketDefaultsOnly = repoConfig({ __file: 'test-config', model: 'provider/model',
    defaults: { tickets: { max_concurrency: 2, quiet_period_ms: 1234 } },
    repos: { 'owner/repo': {} } }, 'owner/repo');
  assert.equal(ticketDefaultsOnly.tickets.max_concurrency, 2, 'defaults.tickets supplies the global cap');
  assert.equal(ticketDefaultsOnly.tickets.quiet_period_ms, 1234);
  assert.equal(ticketDefaultsOnly.tickets.intake_poll_ms, 30_000);
  const ticketOverrides = repoConfig({ __file: 'test-config', model: 'provider/model',
    defaults: { tickets: { max_concurrency: 3, quiet_period_ms: 7, intake_poll_ms: 5_000 } },
    tickets: { max_concurrency: 2, quiet_period_ms: 60_000, intake_poll_ms: 1_000 },
    repos: { 'owner/repo': { tickets: { quiet_period_ms: 5, intake_poll_ms: 2_000,
      activation_mention: 'reisi007-jr' } } } }, 'owner/repo');
  assert.equal(ticketOverrides.tickets.max_concurrency, 2, 'top-level tickets override defaults');
  assert.equal(ticketOverrides.tickets.quiet_period_ms, 5, 'the quiet period may be tuned per repository');
  assert.equal(ticketOverrides.tickets.intake_poll_ms, 2_000, 'the intake cadence may be tuned per repository');
  assert.equal(ticketOverrides.tickets.activation_mention, 'reisi007-jr');
  assert.deepEqual(ticketDefaults.tickets.delivery, { timezone: null, windows: [], cooldownMs: 0 },
    'no delivery window is the default: existing installations run 24/7');
  const deliveryConfigured = repoConfig({ __file: 'test-config', model: 'provider/model',
    defaults: { tickets: { delivery: { timezone: 'UTC', windows: [{ days: 'weekends', start: '10:00', end: '12:00' }],
      cooldown_ms: 5_000 } } },
    tickets: { delivery: { timezone: 'UTC', windows: [{ days: 'weekdays', start: '01:00', end: '04:00' }],
      cooldown_ms: 60_000 } },
    repos: { 'owner/repo': { tickets: { delivery: { timezone: 'Europe/Berlin', windows: [],
      cooldown_ms: 0 } } } } }, 'owner/repo');
  assert.equal(deliveryConfigured.tickets.delivery.timezone, 'Europe/Berlin');
  assert.deepEqual(deliveryConfigured.tickets.delivery.windows, [], 'a repository delivery object replaces lower levels');
  assert.equal(deliveryConfigured.tickets.delivery.cooldownMs, 0);
  const deliveryInherited = repoConfig({ __file: 'test-config', model: 'provider/model',
    tickets: { delivery: { timezone: 'UTC', windows: [{ days: 'weekdays', start: '01:00', end: '04:00' }],
      cooldown_ms: 60_000 } },
    repos: { 'owner/repo': {} } }, 'owner/repo');
  assert.equal(deliveryInherited.tickets.delivery.timezone, 'UTC');
  assert.equal(deliveryInherited.tickets.delivery.windows.length, 1);
  assert.equal(deliveryInherited.tickets.delivery.cooldownMs, 60_000);

  bootstrapDb.close(); questionDb.close(); scopedDb.close();
  newIssueDb.close();
  concurrentDb.close(); foreignReferenceDb.close(); unsafeSummaryDb.close(); pollFailureDb.close();
  changedAfterReadErrorDb.close(); unreadDb.close();
  ignoreDb.close(); retryUpdateDb.close(); failedStatusDb.close(); pausedDb.close(); revokedDb.close(); needsInfoDb.close(); humanDb.close(); commentDb.close(); store.close(); malformedDb.close(); changedDb.close(); retryDb.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ticket-runtime tests passed');
