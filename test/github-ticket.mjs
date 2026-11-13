import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGithubTicketPort } from '../dist/providers/github-ticket.js';

const issue = {
  id: 20, number: 7, title: 'Ticket', body: 'Context', state: 'OPEN', url: 'https://example/7',
  author: { login: 'reporter' }, labels: [{ name: 'agent:auto-implement' }], updatedAt: '2026-01-06T00:00:00Z',
};
const c = (id, body = `comment ${id}`) => ({ id, body, created_at: `2026-01-0${id}T00:00:00Z`, user: { login: 'operator' }, html_url: `https://example/comment/${id}` });
let all = [c(1), c(2)];
const calls = [];
const driver = {
  json(args) {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return [{ ...issue, url: issue.url }];
    if (args[0] === 'issue') return issue;
    return [all]; // gh api --paginate --slurp returns an array of page arrays.
  },
  run(args) {
    calls.push(args);
    const body = args[args.indexOf('--body') + 1];
    all.push(c(3, body));
  },
};
const port = createGithubTicketPort(driver);
assert.equal((await port.select('owner/repo'))[0].number, 7);
await assert.rejects(port.select('--injection/repo'), /owner\/repository/);
const selected = await port.select('owner/repo');
assert.equal(selected[0].author, 'reporter');
assert.equal(selected[0].title, '', 'issue list reads routing metadata without the ticket title');
assert.deepEqual(selected[0].labels, [], 'issue list leaves full ticket context to the agent');
assert.doesNotMatch(calls.find((args) => args[0] === 'issue' && args[1] === 'list').at(-1), /title|body/);
assert.deepEqual(await port.identity('owner/repo', 7), {
  number: 7, author: 'reporter', state: 'OPEN', url: 'https://example/7',
}, 'manual goal authorization reads identity only, not issue text');
assert.doesNotMatch(calls.at(-1).at(-1), /title|body/);
const read = await port.read('owner/repo', 7);
assert.equal(read.comments[0].id, '1');
assert.equal(read.author, 'reporter');
assert.equal(read.updatedAt, '2026-01-06T00:00:00Z');
const batch = await port.updates('owner/repo', 7, '1');
assert.deepEqual(batch.updates.map((x) => x.id), ['2']);
assert.equal(batch.updates[0].body, '', 'routing update reads omit comment bodies');
assert.equal(batch.nextCursor, '2');
await assert.rejects(port.updates('owner/repo', 7, 'missing'), /refusing to skip/);
const first = await port.publishStatus('owner/repo', 7, 'done-1', 'Caller-provided status');
assert.equal(first.skipped, false);
const second = await port.publishStatus('owner/repo', 7, 'done-1', 'different retry body');
assert.deepEqual(second, { id: '3', skipped: true });
assert.equal(calls.filter((x) => x[0] === 'issue' && x[1] === 'comment').length, 1);

const bad = createGithubTicketPort({ json: () => [{ ...c(9), id: undefined }], run() {} });
await assert.rejects(bad.updates('owner/repo', 7, null), /stable id/);
const emptyBody = createGithubTicketPort({
  json: (args) => args[0] === 'issue' && args[1] === 'list' ? [{ ...issue, body: null }] : [issue],
  run() {},
});
assert.equal((await emptyBody.select('owner/repo'))[0].body, '');

let activationIssue = { title: 'Routing request', body: 'Please review this.', updated_at: '2026-04-01T00:00:00Z' };
let activationComments = [];
const activationCalls = [];
const activationPort = createGithubTicketPort({ json(args) {
  activationCalls.push(args);
  if (args[0] === 'api' && args.at(-1) === 'repos/owner/repo/issues/7') return activationIssue;
  if (args[0] === 'api' && args.at(-1).startsWith('repos/owner/repo/issues/7/comments')) return [activationComments];
  throw new Error('unexpected activation fixture request');
}, run() {} });
const activationRequest = { project: 'owner/repo', number: 7, login: 'Reisi007-jr',
  trustedAuthors: ['Trusted', 'tool-user', 'ci-bot'], excludedAuthors: ['tool-user'], updatedAt: activationIssue.updated_at };
assert.equal(await activationPort.hasActivationMention(activationRequest), false);
assert.equal(await activationPort.hasActivationMention(activationRequest), false);
assert.equal(activationCalls.filter((args) => args.at(-1) === 'repos/owner/repo/issues/7').length, 1,
  'activation results cache only by the issue updatedAt during a router process');
activationIssue = { ...activationIssue, body: '@Reisi007-jr-extra', updated_at: '2026-04-01T00:01:00Z' };
activationRequest.updatedAt = activationIssue.updated_at;
assert.equal(await activationPort.hasActivationMention(activationRequest), false,
  'a longer handle is not a complete mention');
activationIssue = { ...activationIssue, body: 'contact x@reisi007-jr please', updated_at: '2026-04-01T00:02:00Z' };
activationRequest.updatedAt = activationIssue.updated_at;
assert.equal(await activationPort.hasActivationMention(activationRequest), false,
  'a mention embedded in another token is not accepted');
activationIssue = { ...activationIssue, title: 'Question for @REISI007-JR!', body: '', updated_at: '2026-04-01T00:03:00Z' };
activationRequest.updatedAt = activationIssue.updated_at;
assert.equal(await activationPort.hasActivationMention(activationRequest), true,
  'the title/body accept an exact case-insensitive handle');
assert.equal(typeof await activationPort.hasActivationMention(activationRequest), 'boolean',
  'the detector returns only a boolean, never issue text');
activationIssue = { ...activationIssue, title: 'Routing request', updated_at: '2026-04-01T00:04:00Z' };
activationComments = [
  { body: 'Please ask @Reisi007-jr', user: { login: 'outsider', type: 'User' } },
  { body: 'Please ask @Reisi007-jr', user: { login: 'tool-user', type: 'User' } },
  { body: 'Please ask @Reisi007-jr', user: { login: 'ci-bot', type: 'Bot' } },
  { body: 'Please ask @Reisi007-jr', user: { login: 'trusted', type: 'User' } },
];
activationRequest.updatedAt = activationIssue.updated_at;
assert.equal(await activationPort.hasActivationMention(activationRequest), true,
  'only trusted, non-bot, non-tool comments can activate');
activationIssue = { ...activationIssue, updated_at: '2026-04-01T00:05:00Z' };
activationComments = activationComments.slice(0, 3);
activationRequest.updatedAt = activationIssue.updated_at;
assert.equal(await activationPort.hasActivationMention(activationRequest), false,
  'untrusted, tool, and bot mentions do not activate');
activationComments = [{ body: 'ask @reisi007-jr_now', user: { login: 'trusted', type: 'User' } }];
activationIssue = { ...activationIssue, updated_at: '2026-04-01T00:06:00Z' };
activationRequest.updatedAt = activationIssue.updated_at;
assert.equal(await activationPort.hasActivationMention(activationRequest), false,
  'an underscore-adjacent handle is not accepted as a complete mention');
const activationFailure = createGithubTicketPort({ json() { throw new Error('private issue body and @reisi007-jr'); }, run() {} });
await assert.rejects(activationFailure.hasActivationMention(activationRequest), (error) => {
  assert.equal(error.message, 'GitHub activation mention check failed');
  assert.doesNotMatch(error.message, /private issue body|reisi007-jr/);
  return true;
}, 'provider failures are sanitized and fail closed');

// Activation comments are read page by page; a mention on a later page must
// still be found without copying any text into the result.
const pagedCalls = [];
const pagedPort = createGithubTicketPort({ json(args) {
  pagedCalls.push(args);
  if (args[0] === 'api' && args.at(-1) === 'repos/owner/repo/issues/7') {
    return { title: 'No mention here', body: '', updated_at: '2026-04-02T00:00:00Z' };
  }
  if (args[0] === 'api' && args.at(-1).startsWith('repos/owner/repo/issues/7/comments')) {
    return [[{ body: 'first page', user: { login: 'trusted', type: 'User' } }],
      [{ body: 'late page asks @Reisi007-jr', user: { login: 'trusted', type: 'User' } }]];
  }
  throw new Error('unexpected paged activation fixture request');
}, run() {} });
assert.equal(await pagedPort.hasActivationMention({ ...activationRequest,
  updatedAt: '2026-04-02T00:00:00Z' }), true,
'a trusted mention on a later comment page activates the issue');
assert.ok(pagedCalls.some((args) => args[0] === 'api' &&
  args.at(-1).startsWith('repos/owner/repo/issues/7/comments')));

// Comment pagination is hard-bounded per call. A long, attacker-amplifiable
// thread is scanned newest-first in small slices; the returned cursor lets a
// later poll continue, so a mention is delayed but never silently lost.
const boundedPages = [];
const pageRows = Array.from({ length: 10 }, (_, index) => Array.from({ length: 100 }, (_, offset) => ({
  body: `page ${index + 1} entry ${offset}`, user: { login: 'trusted', type: 'User' },
})));
const boundedPort = createGithubTicketPort({ json(args) {
  const endpoint = String(args.at(-1));
  if (args[0] === 'api' && endpoint === 'repos/owner/repo/issues/7') {
    return { title: 'No mention', body: '', updated_at: '2026-04-04T00:00:00Z', comments: 1_000 };
  }
  if (args[0] === 'api' && endpoint.startsWith('repos/owner/repo/issues/7/comments')) {
    const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1]);
    boundedPages.push(page);
    return [pageRows[page - 1]];
  }
  throw new Error('unexpected bounded activation fixture request');
}, run() {} });
const boundedRequest = { project: 'owner/repo', number: 7, login: 'reisi007-jr',
  trustedAuthors: ['trusted'], excludedAuthors: [] };
const firstBound = await boundedPort.scanActivationMention({
  ...boundedRequest, newest: true, page: null, maxPages: 3,
});
assert.equal(firstBound.matched, false);
assert.equal(firstBound.complete, false);
assert.equal(firstBound.nextPage, 7, 'the bounded scan reports where it will continue');
assert.deepEqual(boundedPages, [10, 9, 8],
  'one call reads only the bounded newest pages, never the whole thread');
const secondBound = await boundedPort.scanActivationMention({
  ...boundedRequest, newest: false, page: firstBound.nextPage, maxPages: 6,
});
assert.equal(secondBound.complete, false);
assert.equal(secondBound.nextPage, 1);
assert.deepEqual(boundedPages.slice(3), [7, 6, 5, 4, 3, 2]);
const finalBound = await boundedPort.scanActivationMention({
  ...boundedRequest, newest: false, page: secondBound.nextPage, maxPages: 6,
});
assert.equal(finalBound.complete, true);
assert.equal(finalBound.nextPage, null);
assert.deepEqual([...boundedPages].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  'continuing the durable cursor covers every page without re-reading them');
assert.ok(!boundedPages.some((page) => !Number.isSafeInteger(page)));

// Ordinary comments change the issue revision without adding a page. The
// newest page is re-read on every revision change, while the descending
// historical cursor keeps moving down instead of restarting at the top.
let grownCount = 500;
let grownRevision = '2026-04-04T00:00:00Z';
const grownPages = [];
const grownPort = createGithubTicketPort({ json(args) {
  const endpoint = String(args.at(-1));
  if (args[0] === 'api' && endpoint === 'repos/owner/repo/issues/7') {
    return { title: 'No mention', body: '', updated_at: grownRevision, comments: grownCount };
  }
  if (args[0] === 'api' && endpoint.startsWith('repos/owner/repo/issues/7/comments')) {
    const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1]);
    grownPages.push(page);
    return [pageRows[0].map((entry) => ({ ...entry, body: `grown page ${page}` }))];
  }
  throw new Error('unexpected growth activation fixture request');
}, run() {} });
const beforeGrowth = await grownPort.scanActivationMention({
  ...boundedRequest, newest: true, page: null, maxPages: 2,
});
assert.deepEqual(grownPages, [5, 4], 'the initial revision scans newest-first');
assert.equal(beforeGrowth.nextPage, 3);
assert.equal(beforeGrowth.topPage, 5, 'the scan reports the newest page it observed');
// Three polls, each with a new comment on the same newest page.
let growthCursor = beforeGrowth.nextPage;
const progress = [];
for (let poll = 1; poll <= 3; poll += 1) {
  grownPages.length = 0;
  grownRevision = `2026-04-04T00:0${poll}:00Z`;
  const scan = await grownPort.scanActivationMention({
    ...boundedRequest, newest: true, page: growthCursor, knownTop: beforeGrowth.topPage, maxPages: 2,
  });
  assert.equal(grownPages[0], 5, `poll ${poll} still checks the newest page for a late mention`);
  assert.equal(grownPages.length, 2, `poll ${poll} stays within its page budget`);
  progress.push(scan.nextPage);
  growthCursor = scan.nextPage;
}
assert.deepEqual(progress, [2, 1, null],
  'continuous ordinary edits keep the historical cursor moving instead of resetting it');

// A comment burst adds pages above the saved cursor. The revision check
// restarts at the new top so the new page range is not silently skipped, and
// the call remains page-bounded.
const restartCursor = 3;
grownPages.length = 0;
grownCount = 3_000;
grownRevision = '2026-04-05T00:00:00Z';
const afterGrowth = await grownPort.scanActivationMention({
  ...boundedRequest, newest: true, page: restartCursor, knownTop: 5, maxPages: 3,
});
assert.deepEqual(grownPages, [30, 29, 28],
  'a grown thread restarts at the new top instead of jumping to the stale cursor');
assert.equal(afterGrowth.complete, false);
assert.equal(afterGrowth.nextPage, 27);
assert.equal(afterGrowth.topPage, 30);

// A completed scan of the previous revision only re-reads the pages that can
// have changed when comments are appended, not the whole bounded thread.
grownPages.length = 0;
grownRevision = '2026-04-06T00:00:00Z';
grownCount = 3_050;
const completedResume = await grownPort.scanActivationMention({
  ...boundedRequest, newest: true, page: null, knownTop: 30, resumeComplete: true, maxPages: 4,
});
assert.deepEqual(grownPages, [31, 30],
  'a completed revision re-checks the newest page and the previously partial last page only');
assert.equal(completedResume.complete, true);
assert.equal(completedResume.nextPage, null);

const newestMentionPages = [];
const newestMentionPort = createGithubTicketPort({ json(args) {
  const endpoint = String(args.at(-1));
  if (args[0] === 'api' && endpoint === 'repos/owner/repo/issues/7') {
    return { title: 'No mention', body: '', updated_at: '2026-04-05T00:00:00Z', comments: 1_000 };
  }
  if (args[0] === 'api' && endpoint.startsWith('repos/owner/repo/issues/7/comments')) {
    const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1]);
    newestMentionPages.push(page);
    return [pageRows[page - 1].map((entry, index) => index === 0 && page === 10
      ? { ...entry, body: 'late trusted @Reisi007-jr' } : entry)];
  }
  throw new Error('unexpected newest activation fixture request');
}, run() {} });
const newestMention = await newestMentionPort.scanActivationMention({
  ...boundedRequest, newest: true, page: null, maxPages: 3,
});
assert.equal(newestMention.matched, true, 'a late mention on the newest page activates immediately');
assert.deepEqual(newestMentionPages, [10],
  'finding the newest mention stops the bounded scan without reading older pages');

// Mention search is a bounded fallback for issues outside the open-issue
// listing window. It stays advisory; the normal trusted-author and
// per-issue activation checks still apply.
const searchCalls = [];
const searchPort = createGithubTicketPort({ json(args) {
  searchCalls.push(args);
  if (args[0] === 'issue' && args[1] === 'list') {
    return [{ id: 9, number: 9, author: { login: 'trusted' }, state: 'OPEN',
      url: 'https://github.com/owner/repo/issues/9', updatedAt: '2026-02-01T00:00:00Z' }];
  }
  throw new Error('unexpected search fixture request');
}, run() {} });
const mentioned = await searchPort.selectMentioned('owner/repo', 'Reisi007-jr', 25);
assert.equal(mentioned[0].number, 9);
assert.equal(mentioned[0].body, '', 'search returns routing metadata only');
const searchArgs = searchCalls.find((args) => args[0] === 'issue' && args[1] === 'list');
assert.equal(searchArgs[searchArgs.indexOf('--search') + 1], 'is:issue mentions:Reisi007-jr');
assert.equal(searchArgs[searchArgs.indexOf('--limit') + 1], '25');
await assert.rejects(searchPort.selectMentioned('owner/repo', 'not a login'), /activation login/);

// A cached negative result is keyed by the complete policy as well as the
// content revision. Changing the login must not reuse the previous boolean.
let keyedIssueCalls = 0;
const keyedPort = createGithubTicketPort({ json(args) {
  if (args[0] === 'api' && args.at(-1) === 'repos/owner/repo/issues/7') {
    keyedIssueCalls += 1;
    return { title: '', body: 'Ask @first', updated_at: '2026-04-03T00:00:00Z' };
  }
  if (args[0] === 'api' && args.at(-1).startsWith('repos/owner/repo/issues/7/comments')) return [[]];
  throw new Error('unexpected cache fixture request');
}, run() {} });
const keyedRequest = { ...activationRequest, updatedAt: '2026-04-03T00:00:00Z' };
assert.equal(await keyedPort.hasActivationMention({ ...keyedRequest, login: 'first' }), true);
assert.equal(await keyedPort.hasActivationMention({ ...keyedRequest, login: 'second' }), false,
  'a cached result is not reused for a different activation login');
assert.equal(keyedIssueCalls, 2, 'the policy change forces a fresh content check');

const change = (id, body, login = 'operator', createdAt = '2026-01-05T00:00:00Z', extra = {}) => ({
  id, body, created_at: createdAt, user: login === null ? null : { login }, html_url: `https://example/change/${id}`, ...extra,
});
const prRows = {
  'repos/owner/repo/issues/9/comments': [[change(101, 'conversation note')]],
  'repos/owner/repo/pulls/9/comments': [[change(201, 'inline note', 'operator', '2026-01-05T01:00:00Z',
    { path: 'src/a.ts', line: 12 })]],
  'repos/owner/repo/pulls/9/reviews': [[change(301, 'review summary', 'operator', null,
    { submitted_at: '2026-01-05T02:00:00Z' })]],
};
const changeCalls = [];
const changeDriver = { json(args) {
  changeCalls.push(args);
  if (args[0] === 'pr' && args[1] === 'view') {
    return { number: 9, state: 'OPEN', url: 'https://github.com/owner/repo/pull/9' };
  }
  return prRows[args[args.length - 1].split('?')[0]] ?? [];
}, run() {} };
const changePort = createGithubTicketPort(changeDriver);
assert.deepEqual(await changePort.verifyChange('owner/repo', 9), {
  number: 9, state: 'OPEN', url: 'https://github.com/owner/repo/pull/9',
}, 'agent-reported PR associations are verified as the expected repository object');
const prBatch = await changePort.changeUpdates('owner/repo', 9, null);
assert.deepEqual(prBatch.updates.map((x) => x.id), ['issue-comment:101', 'review-comment:201', 'review:301'],
  'conversation, inline review and review comments are merged in time order with type-qualified ids');
assert.ok(prBatch.updates.every((entry) => entry.body === ''), 'PR routing metadata omits all comment/review bodies');
assert.equal(prBatch.updates[1].url, 'https://example/change/201');
assert.ok(changeCalls.some((args) => args[0] === 'api' && args.includes('--jq') && !args[args.indexOf('--jq') + 1].includes('body')),
  'paginated event requests project metadata without fetching comment text');
const prAgain = await changePort.changeUpdates('owner/repo', 9, prBatch.nextCursor);
assert.deepEqual(prAgain.updates, [], 'delivered change comments are not delivered twice');
await assert.rejects(changePort.changeUpdates('owner/repo', 9, 'not-json'), /invalid change update cursor/);
const tiePort = createGithubTicketPort({ json(args) {
  const key = args[args.length - 1].split('?')[0];
  return key === 'repos/owner/repo/issues/9/comments'
    ? [[change(1010, 'ten', 'operator', '2026-01-05T03:00:00Z'),
      change(999, 'nine', 'operator', '2026-01-05T03:00:00Z')]]
    : [];
}, run() {} });
assert.deepEqual((await tiePort.changeUpdates('owner/repo', 9, null)).updates.map((entry) => entry.id),
  ['issue-comment:999', 'issue-comment:1010'],
  'same-timestamp change events use numeric ID order, not lexicographic order');

// A draft review created before later reviews may be submitted afterwards.
// Pending ids plus a submitted_at watermark must deliver it exactly once even
// though its numeric id is below the floor.
const pendingReviews = [
  change(100, 'draft', 'operator', '2026-01-05T00:00:00Z', { state: 'PENDING', submitted_at: null }),
  change(101, 'review', 'operator', '2026-01-05T00:10:00Z',
    { state: 'COMMENTED', submitted_at: '2026-01-05T01:00:00Z' }),
];
const pendingPort = createGithubTicketPort({ json(args) {
  const path = args[args.length - 1].split('?')[0];
  if (path.endsWith('/reviews')) return [pendingReviews];
  return [];
}, run() {} });
const firstPending = await pendingPort.changeUpdates('owner/repo', 9, null);
assert.deepEqual(firstPending.updates.map((entry) => entry.id), ['review:101']);
assert.equal(firstPending.updates[0].createdAt, '2026-01-05T01:00:00Z',
  'a review is timestamped by submitted_at, not its draft created_at');
const pendingCursor = JSON.parse(firstPending.nextCursor);
assert.deepEqual(pendingCursor.pendingReviews, [100]);
assert.equal(pendingCursor.review, 101, 'the floor advances over pending ids');
assert.equal(pendingCursor.reviewSubmittedAt, '2026-01-05T01:00:00Z');
assert.deepEqual(pendingCursor.reviewSubmittedIds, [101], 'ids at the watermark boundary are retained');
pendingReviews[0] = change(100, 'draft', 'operator', '2026-01-05T00:00:00Z',
  { state: 'APPROVED', submitted_at: '2026-01-05T02:00:00Z' });
const lateSubmission = await pendingPort.changeUpdates('owner/repo', 9, firstPending.nextCursor);
assert.deepEqual(lateSubmission.updates.map((entry) => entry.id), ['review:100'],
  'a late submission with a lower id is recovered through the pending set');
assert.equal(lateSubmission.updates[0].createdAt, '2026-01-05T02:00:00Z');
assert.deepEqual((await pendingPort.changeUpdates('owner/repo', 9, lateSubmission.nextCursor)).updates, [],
  'the recovered late review is not delivered twice');
// Same-second boundary: an unseen review submitted at exactly the watermark
// time is not in the recorded boundary ids and must still be delivered.
pendingReviews.push(change(98, 'same-second draft', 'operator', '2026-01-05T00:00:00Z',
  { state: 'APPROVED', submitted_at: '2026-01-05T02:00:00Z' }));
const sameSecond = await pendingPort.changeUpdates('owner/repo', 9, lateSubmission.nextCursor);
assert.deepEqual(sameSecond.updates.map((entry) => entry.id), ['review:98'],
  'an unseen review submitted at the watermark second is delivered, not silently skipped');
assert.deepEqual(JSON.parse(sameSecond.nextCursor).reviewSubmittedIds, [98, 100]);
assert.deepEqual((await pendingPort.changeUpdates('owner/repo', 9, sameSecond.nextCursor)).updates, [],
  'boundary ids prevent redelivering the same-second review');
// A cursor from the intermediate implementation has a watermark but no ids.
// Replay that second once, then establish the boundary ids.
const intermediate = await pendingPort.changeUpdates('owner/repo', 9,
  JSON.stringify({ conversation: 0, review: 101, reviewComment: 0, pendingReviews: [],
    reviewSubmittedAt: '2026-01-05T02:00:00Z' }));
assert.deepEqual(intermediate.updates.map((entry) => entry.id), ['review:98', 'review:100'],
  'an unknown boundary replays its second once instead of skipping an unseen review');
assert.deepEqual((await pendingPort.changeUpdates('owner/repo', 9, intermediate.nextCursor)).updates, []);
// A pending review that was never visible before submission is recovered by
// the submitted_at watermark rather than a numeric id.
pendingReviews.push(change(99, 'hidden draft', 'operator', '2026-01-05T00:00:00Z',
  { state: 'COMMENTED', submitted_at: '2026-01-05T03:00:00Z' }));
assert.deepEqual((await pendingPort.changeUpdates('owner/repo', 9, sameSecond.nextCursor)).updates.map((entry) => entry.id),
  ['review:99'], 'a submitted review below the floor is recovered by its submission time');
// Legacy cursors without a watermark replay submitted reviews once, then stop.
const legacy = await pendingPort.changeUpdates('owner/repo', 9,
  JSON.stringify({ conversation: 0, review: 101, reviewComment: 0 }));
assert.deepEqual(legacy.updates.map((entry) => entry.id),
  ['review:101', 'review:98', 'review:100', 'review:99'],
  'a legacy cursor replays once instead of permanently losing a skipped pending review');
assert.deepEqual((await pendingPort.changeUpdates('owner/repo', 9, legacy.nextCursor)).updates, []);
assert.ok(changeCalls.some((args) => /per_page=100/.test(args[args.length - 1])),
  'change requests use GitHub\'s maximum page size to bound request count');

// Regression: real gh rejects `--paginate --slurp --jq`; with --jq it prints one
// compact JSON document per page. Run the actual CLI driver against a fake gh.
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
const fakeGh = path.join(fakeDir, 'gh');
const callLog = path.join(fakeDir, 'calls.ndjson');
fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };
const row = (id, body, login, createdAt, extra = {}) => ({
  id, body, created_at: createdAt, user: login === null ? null : { login },
  html_url: 'https://example/comment/' + id, ...extra,
});
const pages = {
  'repos/owner/repo/issues/7/comments': [
    [row(1, 'first body', 'operator', '2026-01-05T00:00:00Z'), row(2, 'deleted author', null, '2026-01-05T00:01:00Z')],
    [row(4, 'fourth body', 'operator', '2026-01-05T00:02:00Z')],
  ],
  'repos/owner/repo/issues/9/comments': [
    [row(101, 'one', 'operator', '2026-01-05T00:01:00Z'), row(301, 'shared id issue event', 'operator', '2026-01-05T00:04:00Z')],
    [row(103, 'later issue event', 'operator', '2026-01-05T00:06:00Z')],
  ],
  'repos/owner/repo/pulls/9/comments': [
    [row(201, 'inline one', 'operator', '2026-01-05T00:02:00Z')],
    [row(203, 'inline two', 'operator', '2026-01-05T00:05:00Z')],
  ],
  'repos/owner/repo/pulls/9/reviews': [
    [row(301, 'review summary', 'operator', '2026-01-05T00:03:00Z', { state: 'COMMENTED' }),
      row(302, 'pending review', 'operator', '2026-01-05T00:07:00Z', { state: 'PENDING' })],
  ],
};
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ id: 20, number: 7, title: 'Ticket', body: 'Context',
    author: { login: 'reporter' }, labels: [{ name: 'agent:auto-implement' }], state: 'OPEN',
    url: 'https://github.com/owner/repo/issues/7', updatedAt: '2026-01-06T00:00:00Z' }));
  process.exit(0);
}
if (args[0] === 'api') {
  const jqAt = args.indexOf('--jq');
  if (jqAt >= 0 && args.includes('--slurp')) fail('the \`--slurp\` option is not supported with \`--jq\` or \`--template\`');
  const endpoint = args.at(-1).split('?')[0];
  const data = pages[endpoint];
  if (!data) fail('unexpected endpoint ' + endpoint);
  if (jqAt >= 0) {
    for (const page of data) {
      process.stdout.write(JSON.stringify(page.map((entry) => {
        const projected = { id: entry.id, user: entry.user, created_at: entry.created_at, html_url: entry.html_url };
        if (endpoint.endsWith('/reviews')) Object.assign(projected,
          { submitted_at: entry.submitted_at ?? entry.created_at, path: entry.path, line: entry.line, state: entry.state });
        return projected;
      })) + '\\n');
    }
  } else if (args.includes('--slurp')) {
    process.stdout.write(JSON.stringify(data));
  } else {
    fail('fake gh requires --slurp or --jq');
  }
  process.exit(0);
}
fail('unexpected gh invocation: ' + args.join(' '));
`, { mode: 0o755 });
const previousPath = process.env.PATH;
process.env.PATH = `${fakeDir}${path.delimiter}${previousPath ?? ''}`;
process.env.FAKE_GH_LOG = callLog;
try {
  const realPort = createGithubTicketPort();
  const readAll = await realPort.read('owner/repo', 7);
  assert.deepEqual(readAll.comments.map((entry) => entry.id), ['1', '2', '4'],
    'slurped multi-page issue comments are flattened');
  assert.equal(readAll.comments[1].author, null, 'a deleted comment author is preserved as null');
  const deletedCursor = await realPort.updates('owner/repo', 7, '3');
  assert.deepEqual(deletedCursor.updates.map((entry) => entry.id), ['4'],
    'a deleted cursor resumes with newer events instead of replaying history');
  assert.equal(deletedCursor.nextCursor, '4');

  const changeBatch = await realPort.changeUpdates('owner/repo', 9, null);
  assert.deepEqual(changeBatch.updates.map((entry) => entry.id), [
    'issue-comment:101', 'review-comment:201', 'review:301', 'issue-comment:301',
    'review-comment:203', 'issue-comment:103',
  ], 'every page is parsed and same-numbered events from different collections stay distinct');
  assert.equal(new Set(changeBatch.updates.map((entry) => entry.id)).size, 6);
  assert.deepEqual(JSON.parse(changeBatch.nextCursor), { conversation: 301, review: 302, reviewComment: 203,
    pendingReviews: [302], reviewSubmittedAt: '2026-01-05T00:03:00Z', reviewSubmittedIds: [301] });
  assert.deepEqual((await realPort.changeUpdates('owner/repo', 9, changeBatch.nextCursor)).updates, []);

  const logged = fs.readFileSync(callLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const apiCalls = logged.filter((args) => args[0] === 'api');
  assert.ok(apiCalls.length >= 5);
  assert.ok(apiCalls.every((args) => !(args.includes('--slurp') && args.includes('--jq'))),
    'never combine --slurp with --jq, which gh rejects');
  assert.ok(apiCalls.some((args) => args.includes('--slurp') && !args.includes('--jq')),
    'full comment bodies use valid --paginate --slurp output');
  const metadataCalls = apiCalls.filter((args) => args.includes('--jq'));
  assert.ok(metadataCalls.length >= 4);
  assert.ok(metadataCalls.every((args) => !/\.body|\bbody\b/.test(args[args.indexOf('--jq') + 1])),
    'every paginated projection excludes comment and review bodies');
  assert.ok(metadataCalls.every((args) => !/\bpath\b|\bline\b/.test(args[args.indexOf('--jq') + 1])),
    'review path/line are not requested because TicketComment does not carry them');
} finally {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  delete process.env.FAKE_GH_LOG;
  fs.rmSync(fakeDir, { recursive: true, force: true });
}
console.log('github-ticket tests passed');
