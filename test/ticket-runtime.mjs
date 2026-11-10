import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteStore } from '../dist/core/persistence.js';
import { runTicketHandoff } from '../dist/core/ticket-runtime.js';

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
  return { issue, port, dispatch, statuses, messages, get dispatchCount() { return dispatchCount; }, set comments(v) { comments = v; } };
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
  assert.match([...unread.statuses.values()][0].body, /outcome FAILED.*retry \/goal/);
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
    if (count === 2) return { sessionId: input.sessionId ?? 'session-7', result: validResult('BLOCKED') };
    return { sessionId: input.sessionId, result: validResult('BLOCKED') };
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
  await assert.rejects(run(concurrent, concurrentDb, 55), /already active in another CLI process/);
  releaseDispatch();
  assert.equal((await activeRun).state, 'done');
  assert.equal(concurrent.dispatchCount, 1, 'one active ticket handoff serializes status writes and agent dispatch');
  assert.equal(concurrent.statuses.size, 2);

  concurrentDb.close(); foreignReferenceDb.close(); unsafeSummaryDb.close(); pollFailureDb.close();
  changedAfterReadErrorDb.close(); unreadDb.close();
  ignoreDb.close(); retryUpdateDb.close(); failedStatusDb.close(); pausedDb.close(); revokedDb.close(); needsInfoDb.close(); humanDb.close(); commentDb.close(); store.close(); malformedDb.close(); changedDb.close(); retryDb.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ticket-runtime tests passed');
