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
