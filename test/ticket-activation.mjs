import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteStore } from '../dist/core/persistence.js';
import {
  ACTIVATION_NEGATIVE_CACHE_MS,
  ACTIVATION_SEARCH_BUDGET,
  MAX_ACTIVATION_CHECKS_PER_POLL,
  MAX_ACTIVATION_COMMENT_PAGES_PER_CHECK,
  activationEligibleCandidates,
  activationSearchCost,
  reserveActivationApiBudget,
  reserveActivationSearchBudget,
  ticketHasBeenAdmitted,
  ticketRouteJobId,
} from '../dist/core/ticket-activation.js';
import { ticketPolicy } from '../dist/core/commands.js';
import { runTicketHandoff } from '../dist/core/ticket-runtime.js';

const candidate = (number, updatedAt = `2026-05-0${number}T00:00:00Z`) => ({
  id: String(number), number, title: '', body: '', author: 'human', labels: [],
  state: 'OPEN', url: `https://github.com/owner/repo/issues/${number}`, updatedAt, comments: [],
});

const candidates = [candidate(1), candidate(2)];
const result = await activationEligibleCandidates({
  candidates,
  project: 'owner/repo',
  login: 'reisi007-jr',
  trustedAuthors: ['human'],
  excludedAuthors: [],
  hasActivationMention: async ({ number }) => {
    if (number === 1) throw new Error('temporary activation read failure');
    return true;
  },
});
assert.deepEqual(result.candidates.map((issue) => issue.number), [2],
  'an activation check failure for one issue does not hide the other candidate');
assert.deepEqual(result.failures, [{ issue: 1, error: 'temporary activation read failure' }],
  'the failed issue is reported for the next poll');

let admittedChecks = 0;
const admittedStore = {
  readTicketHandoff(id) {
    return id === ticketRouteJobId('owner/repo', 3)
      ? { state: { activationAdmitted: true, sessionId: 'persisted-session' } }
      : null;
  },
};
assert.equal(ticketHasBeenAdmitted(admittedStore, 'OWNER/RepO', 3), true,
  'the durable admission latch is found through a case-insensitive project key');
const admitted = await activationEligibleCandidates({
  candidates: [candidate(3, '2026-05-04T00:00:00Z')],
  project: 'owner/repo',
  login: 'reisi007-jr',
  trustedAuthors: ['human'],
  excludedAuthors: [],
  store: admittedStore,
  hasActivationMention: async () => { admittedChecks += 1; return false; },
});
assert.deepEqual(admitted.candidates.map((issue) => issue.number), [3]);
assert.equal(admittedChecks, 0, 'an already admitted issue never reads activation text again');

const noLogin = await activationEligibleCandidates({
  candidates,
  project: 'owner/repo',
  login: undefined,
  trustedAuthors: ['human'],
  excludedAuthors: [],
  hasActivationMention: async () => { throw new Error('must not be called without a configured login'); },
});
assert.deepEqual(noLogin.candidates, candidates);
assert.deepEqual(noLogin.failures, []);

const rc = {
  project: 'owner/repo', account: 'configured-account', tracker_account: null, code_host_account: null,
  trusted_authors: ['human'], tool_authors: [], auto_merge: false,
  labels: { auto_implement: 'agent:auto-implement' },
  tickets: {
    activation_mention: 'reisi007-jr', bootstrap: ['Start the ticket session.'], system_prompt: 'stable prompt',
    max_concurrency: 1, quiet_period_ms: 0, intake_poll_ms: 30_000, post_merge_poll_ms: 0,
    post_merge_poll_limit: 1, delivery: null,
  },
};
const cfg = { __file: 'test-config', model: 'provider/model', accounts: ['configured-account'] };
const pollPolicy = ticketPolicy(cfg, rc, undefined, {
  routeOnly: true, ticketUrl: 'https://github.com/owner/repo/issues/1',
});
assert.equal(pollPolicy.activationMention, 'reisi007-jr',
  'the poller policy carries the configured activation gate');
const goalPolicy = ticketPolicy(cfg, rc, 'explicit operator criteria', {
  routeOnly: true, activationMention: null, ticketUrl: 'https://github.com/owner/repo/issues/1',
});
assert.equal(goalPolicy.activationMention, undefined,
  'an explicit operator goal bypasses the poller activation gate');
assert.equal(goalPolicy.goal, 'explicit operator criteria',
  'the explicit goal still retains its private acceptance criteria');

// Exercise the same policy through the runtime: an explicit goal must dispatch
// without reading activation text even though the repository has the gate set.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-activation-'));
const store = new SQLiteStore(path.join(dir, 'activation.sqlite3'));
try {
  let activationChecks = 0;
  let dispatches = 0;
  const port = {
    updates: async () => ({ updates: [], nextCursor: null }),
    hasActivationMention: async () => { activationChecks += 1; return false; },
    publishStatus: async (_project, _issue, key) => ({ id: `status-${key}`, skipped: true }),
  };
  const outcome = await runTicketHandoff({
    port,
    store,
    project: 'owner/repo',
    issue: 1,
    policy: { ...goalPolicy, quietPeriodMs: 0 },
    dispatch: async () => {
      dispatches += 1;
      return { sessionId: 'explicit-goal-session', result: {
        status: 'DONE', summary: 'Completed', changed_files: [], commands: [], acceptance: [],
        blocked_reason: null, evidence_dir: null, verdict: 'DONE',
      } };
    },
  });
  assert.equal(outcome.state, 'done');
  assert.equal(dispatches, 1, 'an explicit goal starts the ticket session without a mention');
  assert.equal(activationChecks, 0, 'an explicit goal never invokes the poller activation check');
} finally {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Bounded checks, fair rotation, durable progress and per-issue failures ---

assert.ok(MAX_ACTIVATION_CHECKS_PER_POLL > 0 && MAX_ACTIVATION_CHECKS_PER_POLL <= 100,
  'the per-poll activation check budget is a small hard bound');
assert.ok(MAX_ACTIVATION_COMMENT_PAGES_PER_CHECK > 0 && MAX_ACTIVATION_COMMENT_PAGES_PER_CHECK <= 10,
  'the per-check comment page budget is a small hard bound');

const many = Array.from({ length: MAX_ACTIVATION_CHECKS_PER_POLL + 10 }, (_, index) =>
  candidate(index + 1, `2026-05-01T00:00:${String(index).padStart(2, '0')}Z`));
const budgetCalls = [];
const budgeted = await activationEligibleCandidates({
  candidates: many,
  project: 'owner/repo',
  login: 'reisi007-jr',
  trustedAuthors: ['human'],
  excludedAuthors: [],
  now: () => 1_000,
  hasActivationMention: async ({ number }) => { budgetCalls.push(number); return false; },
});
assert.equal(budgetCalls.length, MAX_ACTIVATION_CHECKS_PER_POLL,
  'one discovery pass never exceeds the activation check budget');
assert.equal(budgeted.checks, MAX_ACTIVATION_CHECKS_PER_POLL);
assert.deepEqual(budgeted.deferred, many.slice(MAX_ACTIVATION_CHECKS_PER_POLL).map((issue) => issue.number),
  'candidates beyond the budget are reported instead of silently dropped');
assert.deepEqual(budgeted.candidates, [], 'no unmentioned candidate is admitted by the bounded pass');

const boundsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-activation-bounds-'));
const rotationFile = path.join(boundsDir, 'activation-rotation.sqlite3');
let rotationStore = new SQLiteStore(rotationFile);
try {
  const four = [candidate(31, '2026-06-01T00:00:00Z'), candidate(32, '2026-06-01T00:00:01Z'),
    candidate(33, '2026-06-01T00:00:02Z'), candidate(34, '2026-06-01T00:00:03Z')];
  let rotationNow = 5_000;
  const rotationCalls = [];
  const rotationPolicy = {
    candidates: four, project: 'owner/repo', login: 'reisi007-jr',
    trustedAuthors: ['human'], excludedAuthors: [], store: rotationStore,
    now: () => rotationNow, maxChecks: 2,
    hasActivationMention: async ({ number }) => { rotationCalls.push(number); return false; },
  };
  const firstRotation = await activationEligibleCandidates(rotationPolicy);
  assert.deepEqual(rotationCalls, [31, 32], 'the first bounded pass checks the oldest unseen candidates');
  assert.deepEqual(firstRotation.deferred, [33, 34]);
  rotationNow += 1;
  rotationCalls.length = 0;
  const secondRotation = await activationEligibleCandidates(rotationPolicy);
  assert.deepEqual(rotationCalls, [33, 34],
    'the next pass reaches the candidates the previous budget deferred');
  assert.deepEqual(secondRotation.deferred, [], 'every candidate gets a turn under a small budget');
  rotationNow += 1;
  rotationCalls.length = 0;
  const cachedRotation = await activationEligibleCandidates(rotationPolicy);
  assert.deepEqual(rotationCalls, [],
    'unchanged completed negatives are not re-read on every poll');
  assert.deepEqual(cachedRotation.candidates, []);
  // A changed revision bypasses the negative cache and wins the next budget.
  four[0].updatedAt = '2026-06-02T00:00:00Z';
  rotationNow += ACTIVATION_NEGATIVE_CACHE_MS + 1;
  rotationCalls.length = 0;
  await activationEligibleCandidates({ ...rotationPolicy, maxChecks: 1 });
  assert.equal(rotationCalls[0], 31, 'a newly updated issue is checked before rotation order');
  const stored = rotationStore.db.prepare(
    'SELECT project,issue,policy,revision,matched,complete_revision,next_page,checked_at,failures FROM ticket_activation_state',
  ).all();
  assert.ok(stored.length >= 4);
  assert.ok(stored.every((row) => typeof row.revision === 'string' && (row.matched === 0 || row.matched === 1)),
    'durable activation rows contain only content-free revisions, booleans and page numbers');
  assert.doesNotMatch(JSON.stringify(stored), /human|reisi007-jr|@/,
    'neither author policy nor issue/comment text is persisted');
} finally {
  rotationStore.close();
}

// The comment-page cursor is durable and survives a worker restart. An
// incomplete scan is reported and never becomes a silent negative.
const progressFile = path.join(boundsDir, 'activation-progress.sqlite3');
let progressStore = new SQLiteStore(progressFile);
const progressCandidate = candidate(41, '2026-07-01T00:00:00Z');
const progressRequests = [];
const progressScan = async (request) => {
  progressRequests.push(request);
  if (progressRequests.length === 1) {
    return { matched: false, complete: false, nextPage: 7, revision: '2026-07-01T00:00:00Z', topPage: 9 };
  }
  return { matched: true, complete: true, nextPage: null, revision: '2026-07-01T00:00:00Z', topPage: 9 };
};
try {
  const firstProgress = await activationEligibleCandidates({
    candidates: [progressCandidate], project: 'owner/repo', login: 'reisi007-jr',
    trustedAuthors: ['human'], excludedAuthors: [], store: progressStore,
    scanActivationMention: progressScan, now: () => 10_000,
  });
  assert.deepEqual(firstProgress.incomplete, [{ issue: 41, nextPage: 7 }],
    'a hard page cap surfaces the next page instead of a negative result');
  assert.equal(firstProgress.checks, 1);
  assert.equal(progressRequests[0].page, null);
  assert.equal(progressRequests[0].newest, true);
  assert.equal(progressRequests[0].knownTop, null);
  assert.equal(progressRequests[0].resumeComplete, false);
  progressStore.close();
  progressStore = new SQLiteStore(progressFile);
  const secondProgress = await activationEligibleCandidates({
    candidates: [progressCandidate], project: 'owner/repo', login: 'reisi007-jr',
    trustedAuthors: ['human'], excludedAuthors: [], store: progressStore,
    scanActivationMention: progressScan, now: () => 10_001,
  });
  assert.deepEqual(secondProgress.candidates.map((issue) => issue.number), [41]);
  assert.equal(progressRequests[1].page, 7, 'the restart resumes the durable descending page cursor');
  assert.equal(progressRequests[1].knownTop, 9, 'the saved newest page travels with the cursor');
  assert.equal(progressRequests[1].newest, false, 'an in-progress scan does not restart at the newest page');
  assert.equal(progressRequests[1].resumeComplete, false, 'an incomplete range is not reported as complete');
  const thirdProgress = await activationEligibleCandidates({
    candidates: [progressCandidate], project: 'owner/repo', login: 'reisi007-jr',
    trustedAuthors: ['human'], excludedAuthors: [], store: progressStore,
    scanActivationMention: async () => { throw new Error('a matched durable state must not be rechecked'); },
    now: () => 10_002,
  });
  assert.deepEqual(thirdProgress.candidates.map((issue) => issue.number), [41],
    'a durable positive result survives another restart without another API read');
} finally {
  progressStore.close();
}

// A repeatedly failing issue yields the budget to healthy issues and backs off
// instead of triggering an activation API call on every poll.
const failureFile = path.join(boundsDir, 'activation-failure.sqlite3');
const failureStore = new SQLiteStore(failureFile);
try {
  let failureNow = 20_000;
  const failureCalls = [];
  const failureArgs = {
    candidates: [candidate(51, '2026-08-01T00:00:00Z'), candidate(52, '2026-08-01T00:00:01Z')],
    project: 'owner/repo', login: 'reisi007-jr', trustedAuthors: ['human'], excludedAuthors: [],
    store: failureStore, now: () => failureNow, maxChecks: 2,
    hasActivationMention: async ({ number }) => {
      failureCalls.push(number);
      if (number === 51) throw new Error('temporary activation read failure');
      return true;
    },
  };
  const firstFailure = await activationEligibleCandidates(failureArgs);
  assert.deepEqual(failureCalls, [51, 52], 'a per-issue failure does not hide the healthy candidate');
  assert.deepEqual(firstFailure.candidates.map((issue) => issue.number), [52]);
  assert.deepEqual(firstFailure.failures, [{ issue: 51, error: 'temporary activation read failure' }]);
  failureCalls.length = 0;
  failureNow += 1_000;
  const backingOff = await activationEligibleCandidates(failureArgs);
  assert.deepEqual(failureCalls, [], 'a failed activation check backs off instead of retrying every poll');
  assert.deepEqual(backingOff.retrying, [51],
    'a failed activation check backs off instead of retrying every poll');
  failureNow += 31_000;
  failureCalls.length = 0;
  await activationEligibleCandidates(failureArgs);
  assert.deepEqual(failureCalls, [51], 'the failed issue is retried after its bounded backoff');
} finally {
  failureStore.close();
}

// A completed scan records the newest page it covered. A later revision change
// asks the provider to re-check only the newest range instead of the whole
// thread, and a grown range is reported as incomplete, never as a negative.
const completedFile = path.join(boundsDir, 'activation-completed.sqlite3');
const completedStore = new SQLiteStore(completedFile);
const completedRequests = [];
let completedRevision = '2026-10-01T00:00:00Z';
try {
  const completedScan = async (request) => {
    completedRequests.push({ ...request });
    return completedRequests.length === 1
      ? { matched: false, complete: true, nextPage: null, revision: completedRevision, topPage: 12 }
      : { matched: false, complete: false, nextPage: 11, revision: completedRevision, topPage: 13 };
  };
  const completedArgs = {
    project: 'owner/repo', login: 'reisi007-jr', trustedAuthors: ['human'], excludedAuthors: [],
    store: completedStore, scanActivationMention: completedScan, now: () => 600_000,
  };
  const finished = await activationEligibleCandidates({ ...completedArgs,
    candidates: [candidate(71, completedRevision)] });
  assert.deepEqual(finished.incomplete, []);
  assert.equal(completedRequests[0].resumeComplete, false);
  completedRevision = '2026-10-02T00:00:00Z';
  const grownScan = await activationEligibleCandidates({ ...completedArgs,
    candidates: [candidate(71, completedRevision)] });
  assert.equal(completedRequests[1].newest, true, 'a revision change checks the newest page');
  assert.equal(completedRequests[1].resumeComplete, true,
    'a completed revision re-checks only the newest range instead of the thread');
  assert.equal(completedRequests[1].knownTop, 12);
  assert.deepEqual(grownScan.incomplete, [{ issue: 71, nextPage: 11 }],
    'a grown newest range is reported as incomplete rather than as unmentioned');
} finally {
  completedStore.close();
}

// --- Shared, durable, time-based activation API budget ---

assert.equal(activationSearchCost(1), 1);
assert.equal(activationSearchCost(100), 1);
assert.equal(activationSearchCost(250), 3);
assert.equal(activationSearchCost(1000), 10, 'search cost conservatively assumes 100 results per request');

const apiBudgetFile = path.join(boundsDir, 'activation-api-budget.sqlite3');
let apiBudgetStore = new SQLiteStore(apiBudgetFile);
const tinyBudget = { limit: 10, windowMs: 60_000 };
const budgetCandidates = [61, 62, 63, 64].map((number) =>
  candidate(number, `2026-09-01T00:00:0${number % 10}Z`));
let budgetNow = 500_000;
const apiCalls = [];
const budgetArgs = () => ({
  candidates: budgetCandidates, project: 'owner/repo', login: 'reisi007-jr',
  trustedAuthors: ['human'], excludedAuthors: [], store: apiBudgetStore,
  now: () => budgetNow, maxChecks: 4, apiBudget: tinyBudget,
  scanActivationMention: async ({ number }) => {
    apiCalls.push(number);
    return { matched: false, complete: true, nextPage: null, revision: `2026-09-01T00:00:0${number % 10}Z`, topPage: null };
  },
});
try {
  // One scan check reserves 1 issue read + 4 comment pages = 5 requests.
  const firstBudgeted = await activationEligibleCandidates(budgetArgs());
  assert.deepEqual(apiCalls, [61, 62], 'the shared budget admits exactly two worst-case reservations');
  assert.deepEqual(firstBudgeted.budgetDenied, [63, 64],
    'candidates without budget are reported before any provider request');
  assert.equal(firstBudgeted.checks, 2);
  assert.ok(firstBudgeted.budgetRetryAt > budgetNow,
    'the budget reports when a reservation becomes possible again');

  // A second poller opening the same database must see the same empty bucket
  // and make no provider call. A restart keeps the persisted refill anchor.
  const secondHandle = new SQLiteStore(apiBudgetFile);
  const deniedByPeer = await activationEligibleCandidates({ ...budgetArgs(), store: secondHandle });
  assert.deepEqual(apiCalls, [61, 62], 'an exhausted shared budget causes no API storm');
  assert.deepEqual(deniedByPeer.budgetDenied, [63, 64]);
  secondHandle.close();
  apiBudgetStore.close();
  apiBudgetStore = new SQLiteStore(apiBudgetFile);
  const deniedAfterRestart = await activationEligibleCandidates(budgetArgs());
  assert.deepEqual(apiCalls, [61, 62], 'a restart does not reset an exhausted budget');

  // Time is the only thing that refills the bucket; refill is continuous.
  assert.equal(deniedAfterRestart.budgetRetryAt, firstBudgeted.budgetRetryAt,
    'the refill anchor and retry time survive a worker restart');
  budgetNow += tinyBudget.windowMs / 2 - 1;
  await activationEligibleCandidates(budgetArgs());
  assert.deepEqual(apiCalls, [61, 62], 'half a window is not enough for the next reservation');
  budgetNow += 1;
  const halfRefill = await activationEligibleCandidates(budgetArgs());
  assert.deepEqual(apiCalls, [61, 62, 63], 'elapsed time admits exactly one half-window reservation');
  assert.deepEqual(halfRefill.budgetDenied, [64]);
  budgetNow += tinyBudget.windowMs / 2;
  const refilled = await activationEligibleCandidates(budgetArgs());
  assert.deepEqual(apiCalls, [61, 62, 63, 64], 'the shared budget refills with elapsed time');
  assert.deepEqual(refilled.budgetDenied, []);
  assert.equal(reserveActivationApiBudget(apiBudgetStore, 6, {
    now: budgetNow, budget: tinyBudget, project: 'owner/repo' }).granted,
    false, 'a reservation larger than the remaining bucket is denied');

  // Negatives from the two admitted checks are cached, so a later poll spends
  // nothing on them; only genuinely unchecked candidates consume the bucket.
  apiCalls.length = 0;
  await activationEligibleCandidates(budgetArgs());
  assert.deepEqual(apiCalls, [], 'completed negatives do not consume API budget again');
} finally {
  apiBudgetStore.close();
}

// --- Separate shared search budget across more than four saturated projects ---
// A token bucket with capacity 30 would still allow a burst plus refill in one
// minute. The separate durable rolling log keeps every rolling minute within
// GitHub's 30 search requests, however many projects or pollers compete.
const searchFile = path.join(boundsDir, 'activation-search-budget.sqlite3');
const searchStore = new SQLiteStore(searchFile);
try {
  const searchNow = 7_000_000;
  const searchProjects = ['owner/a', 'owner/b', 'owner/c', 'owner/d', 'owner/e'];
  const firstSearch = searchProjects.map((project) => reserveActivationSearchBudget(searchStore,
    activationSearchCost(1000), { now: searchNow, project }));
  assert.deepEqual(firstSearch.map((entry) => entry.granted), [true, true, true, false, false],
    'five saturated projects still stay within 30 search requests per rolling minute');
  assert.deepEqual(firstSearch.slice(3).map((entry) => entry.retryAt),
    [searchNow + 60_000, searchNow + 60_000],
    'denied projects wait for the oldest grants to expire');
  assert.equal(reserveActivationApiBudget(searchStore, 45, {
    now: searchNow, project: 'owner/a' }).granted, true,
  'search reservations do not consume the separate issue-read bucket');
  assert.equal(reserveActivationSearchBudget(searchStore, 10, {
    now: searchNow + 59_999, project: 'owner/d' }).granted, false,
  'the search budget does not refill early');
  assert.equal(reserveActivationSearchBudget(searchStore, 10, {
    now: searchNow + 60_000, project: 'owner/d' }).granted, true,
  'a denied project is admitted when the rolling window refills');
  assert.equal(reserveActivationSearchBudget(searchStore, 10, {
    now: searchNow + 60_000, project: 'owner/e' }).granted, true,
  'a second denied project is admitted when the rolling window refills');
  assert.equal(reserveActivationSearchBudget(searchStore, 10, {
    now: searchNow + 60_000, project: 'owner/a' }).granted, true,
  'the remaining ten-request slice of the refilled window is still admitted');
  assert.equal(reserveActivationSearchBudget(searchStore, 10, {
    now: searchNow + 60_000, project: 'owner/b' }).granted, false,
  'more than four projects share one refilled window without overdrawing it');
  assert.equal(reserveActivationSearchBudget(searchStore, 31, {
    now: searchNow + 60_000, project: 'owner/a' }).granted, false,
  'an oversized search reservation fails closed');
} finally {
  searchStore.close();
}

// --- Durable fair cross-project scheduling of the shared budget ---
// Two projects with independent demand, a restart between polls, and a search
// reservation: the project that consumed budget rotates behind the other one,
// so the first configured project cannot starve later projects across polls.
const fairFile = path.join(boundsDir, 'activation-api-fair.sqlite3');
let fairStore = new SQLiteStore(fairFile);
const fairBudget = { limit: 10, windowMs: 60_000 };
const fairProjects = ['owner/alpha', 'owner/beta'];
let fairNow = 2_000_000;
const runFairProject = async (project, base, revision) => {
  const calls = [];
  const outcome = await activationEligibleCandidates({
    candidates: [0, 1, 2, 3].map((offset) => candidate(base + offset, revision)),
    project, login: 'reisi007-jr', trustedAuthors: ['human'], excludedAuthors: [],
    store: fairStore, now: () => fairNow, maxChecks: 4, apiBudget: fairBudget,
    scanActivationMention: async ({ number }) => {
      calls.push(number);
      return { matched: false, complete: true, nextPage: null, revision, topPage: null };
    },
  });
  return { calls, outcome };
};
const pollFair = async (base, revision) => {
  const order = fairStore.activationBudgetFairOrder(fairProjects);
  const calls = {};
  for (const project of order) {
    const offset = project === 'owner/alpha' ? 0 : 100;
    calls[project] = (await runFairProject(project, base + offset, revision)).calls;
  }
  return { order, calls };
};
try {
  const firstFair = await pollFair(1_000, '2026-12-01T00:00:00Z');
  assert.deepEqual(firstFair.order, ['owner/alpha', 'owner/beta'],
    'a fresh budget breaks the never-served tie by stable project name');
  assert.equal(firstFair.calls['owner/alpha'].length, 2,
    'the first project spends the whole bucket when its demand is high');
  assert.deepEqual(firstFair.calls['owner/beta'], [],
    'the second project makes no provider call while the shared bucket is empty');

  fairStore.close();
  fairStore = new SQLiteStore(fairFile);
  fairNow += fairBudget.windowMs;
  const secondFair = await pollFair(2_000, '2026-12-02T00:00:00Z');
  assert.deepEqual(secondFair.order, ['owner/beta', 'owner/alpha'],
    'after a restart the project that received no budget is served first');
  assert.equal(secondFair.calls['owner/beta'].length, 2,
    'the previously starved project consumes the full refilled bucket');
  assert.deepEqual(secondFair.calls['owner/alpha'], [],
    'the rotation gives the later project its turn instead of the first one again');

  fairNow += fairBudget.windowMs;
  const thirdFair = await pollFair(3_000, '2026-12-03T00:00:00Z');
  assert.deepEqual(thirdFair.order, ['owner/alpha', 'owner/beta'],
    'the rotation keeps alternating across separate polls');
  assert.equal(thirdFair.calls['owner/alpha'].length, 2);

  // The mention search draws from the separate search budget but advances the
  // same rotation, so a search-only project cannot pin itself to the front.
  fairNow += fairBudget.windowMs;
  assert.equal(ACTIVATION_SEARCH_BUDGET.limit, 30,
    'the search budget matches GitHub 30 requests per minute');
  assert.equal(ACTIVATION_SEARCH_BUDGET.windowMs, 60_000);
  assert.equal(reserveActivationSearchBudget(fairStore, activationSearchCost(1000), {
    now: fairNow, project: 'owner/beta' }).granted, true,
  'a fresh search window admits the bounded mention search reservation');
  assert.deepEqual(fairStore.activationBudgetFairOrder(fairProjects), ['owner/alpha', 'owner/beta'],
    'a search reservation moves its project behind the other project');
} finally {
  fairStore.close();
}

fs.rmSync(boundsDir, { recursive: true, force: true });
console.log('ticket activation isolates per-issue failures and shares one fair, time-based API budget');
