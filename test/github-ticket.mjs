import assert from 'node:assert/strict';
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
assert.deepEqual(selected[0].labels, ['agent:auto-implement']);
const read = await port.read('owner/repo', 7);
assert.equal(read.comments[0].id, '1');
assert.equal(read.author, 'reporter');
assert.equal(read.updatedAt, '2026-01-06T00:00:00Z');
const batch = await port.updates('owner/repo', 7, '1');
assert.deepEqual(batch.updates.map((x) => x.id), ['2']);
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
console.log('github-ticket tests passed');
