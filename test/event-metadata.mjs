import assert from 'node:assert/strict';
import {
  EVENT_NOTIFICATION_NOTE,
  aggregateEventMetadata,
  classifyPullRequestTransition,
  classifyTicketEvent,
  issueCreatedMetadata,
  issueEditedMetadata,
  metadataFromTicketUpdate,
  normalizeEventMetadata,
  pullRequestTransitionMetadata,
  summarizeEventDigest,
} from '../dist/core/event-metadata.js';

// Metadata is the only thing that may cross the boundary. Content fields fail
// closed instead of being silently dropped, so a caller cannot pass issue text.
for (const forbidden of ['body', 'title', 'content', 'diff', 'files', 'comments']) {
  assert.throws(() => normalizeEventMetadata({ category: 'issue-comment', id: '1', [forbidden]: 'secret' }),
    new RegExp(`unsupported field "${forbidden}"`), forbidden);
}
const valid = normalizeEventMetadata({
  category: 'pr-review',
  id: 'review:12',
  url: 'https://github.com/owner/repo/pull/7#pullrequestreview-12',
  occurredAt: '2026-11-09T10:00:00Z',
});
assert.deepEqual(valid, {
  category: 'pr-review',
  id: 'review:12',
  url: 'https://github.com/owner/repo/pull/7#pullrequestreview-12',
  occurredAt: '2026-11-09T10:00:00Z',
});
assert.throws(() => normalizeEventMetadata({ category: 'made-up', id: '1' }), /category must be one of/);
assert.throws(() => normalizeEventMetadata({ category: 'issue-comment', id: '' }), /id must be a non-empty string/);
assert.throws(() => normalizeEventMetadata({ category: 'issue-comment', id: '1\n2' }), /control characters/);
assert.throws(() => normalizeEventMetadata({ category: 'issue-comment', id: '1', url: 'javascript:alert(1)' }),
  /HTTP\(S\) URL/);
assert.throws(() => normalizeEventMetadata({ category: 'issue-comment', id: '1', occurredAt: 'not-a-date' }),
  /parseable timestamp/);
assert.throws(() => normalizeEventMetadata({ category: 'issue-comment', id: '1', fields: [] }), /non-empty array/);
assert.throws(() => normalizeEventMetadata(null), /must be an object/);
assert.deepEqual(normalizeEventMetadata({ category: 'issue-comment', id: '1', fields: ['body', 'body'] }).fields,
  ['body']);

// Categories come only from facts the provider parsed. A bare `change` source
// cannot tell a PR conversation comment from a review, so it stays unclassified.
assert.equal(classifyTicketEvent({ id: '123', source: 'ticket' }), 'issue-comment');
assert.equal(classifyTicketEvent({ id: 'issue-comment:44', source: 'change' }), 'pr-conversation');
assert.equal(classifyTicketEvent({ id: 'review-comment:45', source: 'change' }), 'pr-review-comment');
assert.equal(classifyTicketEvent({ id: 'review:46', source: 'change' }), 'pr-review');
assert.equal(classifyTicketEvent({ id: '47', source: 'change' }), 'unclassified');
assert.equal(classifyTicketEvent({ id: '48' }), 'unclassified');
assert.equal(classifyTicketEvent({ id: 'goal:abc', source: 'operator' }), null,
  'operator criteria are not GitHub activity and are not notified as an event');

// Converting a provider update ignores content even when the object contains it.
const comment = metadataFromTicketUpdate({
  id: 'review:46',
  source: 'change',
  url: 'https://github.com/owner/repo/pull/3#pullrequestreview-46',
  createdAt: '2026-11-09T11:00:00Z',
  body: 'do not forward this review body',
  title: 'do not forward this title',
});
assert.deepEqual(comment, {
  category: 'pr-review',
  id: 'review:46',
  url: 'https://github.com/owner/repo/pull/3#pullrequestreview-46',
  occurredAt: '2026-11-09T11:00:00Z',
});
assert.equal(JSON.stringify(comment).includes('do not forward'), false);
assert.deepEqual(metadataFromTicketUpdate({ id: '47', source: 'change' }), {
  category: 'unclassified',
  id: '47',
  source: 'change',
});
assert.equal(metadataFromTicketUpdate({ id: 'goal:abc', source: 'operator' }), null);

// Issue creation is distinct from a verified text edit. A snapshot difference
// alone cannot prove who edited, so untrusted or unknown actors produce nothing.
const created = issueCreatedMetadata({ id: 'issue:7', url: 'https://github.com/owner/repo/issues/7',
  occurredAt: '2026-11-09T09:00:00Z' });
assert.deepEqual(created, {
  category: 'issue-created',
  id: 'issue:7',
  url: 'https://github.com/owner/repo/issues/7',
  occurredAt: '2026-11-09T09:00:00Z',
});
assert.equal(issueEditedMetadata({ id: 'issue-edit:7', fields: ['title', 'body'],
  actor: 'Trusted', trustedAuthors: ['trusted', 'other'] }).category, 'issue-edited');
assert.deepEqual(issueEditedMetadata({ id: 'issue-edit:7', fields: ['body', 'title', 'labels'],
  actor: 'trusted', trustedAuthors: ['trusted'] }).fields, ['body', 'title'],
  'only text field names are reported, never values or unrelated fields');
assert.equal(issueEditedMetadata({ id: 'issue-edit:7', fields: ['title'], actor: 'stranger',
  trustedAuthors: ['trusted'] }), null);
assert.equal(issueEditedMetadata({ id: 'issue-edit:7', fields: ['title'], actor: 'trusted',
  trustedAuthors: ['trusted'] }).url, undefined);
assert.equal(issueEditedMetadata({ id: 'issue-edit:7', fields: ['title'] }), null,
  'an API that cannot prove the editor must not invent trust');
assert.equal(issueEditedMetadata({ id: 'issue-edit:7', fields: ['labels'], actor: 'trusted',
  trustedAuthors: ['trusted'] }), null);

// Associated-PR transitions are classified without inventing a merge.
assert.equal(classifyPullRequestTransition(null, 'OPEN'), null, 'first association is not activity');
assert.equal(classifyPullRequestTransition('OPEN', 'OPEN'), null);
assert.equal(classifyPullRequestTransition('open', 'OPEN'), null);
assert.equal(classifyPullRequestTransition(null, 'MERGED'), 'pr-merge');
assert.equal(classifyPullRequestTransition('OPEN', 'MERGED'), 'pr-merge');
assert.equal(classifyPullRequestTransition('OPEN', 'CLOSED'), 'pr-closed');
assert.equal(classifyPullRequestTransition('CLOSED', 'OPEN'), 'pr-state-changed');
assert.equal(classifyPullRequestTransition('OPEN', 'DRAFT'), 'pr-state-changed');
assert.equal(pullRequestTransitionMetadata({ id: 'pull:3:merged', previousState: 'OPEN', state: 'MERGED',
  url: 'https://github.com/owner/repo/pull/3' }).category, 'pr-merge');
assert.equal(pullRequestTransitionMetadata({ id: 'pull:3:open', previousState: 'OPEN', state: 'OPEN' }), null);

// Aggregation keeps full counts, first-seen category order, de-duplicates
// identities and bounds only the references, never the count.
const digest = aggregateEventMetadata([
  { category: 'issue-comment', id: '1', url: 'https://github.com/o/r/issues/7#issuecomment-1',
    occurredAt: '2026-11-09T10:00:00Z' },
  { category: 'issue-comment', id: '2', occurredAt: '2026-11-09T07:00:00+01:00' },
  { category: 'issue-comment', id: '1', url: 'https://github.com/o/r/issues/7#issuecomment-1' },
  { category: 'pr-review', id: 'review:3', occurredAt: '2026-11-09T12:00:00Z' },
  { category: 'pr-merge', id: 'pull:3:merged' },
  { category: 'unclassified', id: '9', source: 'change', occurredAt: '2026-11-08T23:00:00Z' },
], { maxReferencesPerCategory: 1 });
assert.equal(digest.total, 5, 'duplicate identity is counted once');
assert.deepEqual(digest.categories.map((entry) => entry.category),
  ['issue-comment', 'pr-review', 'pr-merge', 'unclassified'], 'first-seen category order');
assert.equal(digest.categories[0].count, 2, 'the count is not truncated by the reference cap');
assert.equal(digest.categories[0].references.length, 1);
assert.equal(digest.categories[0].references[0].id, '1');
assert.deepEqual(digest.categories[3].sources, ['change'], 'unclassified keeps the raw source');
assert.equal(digest.firstOccurredAt, '2026-11-08T23:00:00Z');
assert.equal(digest.lastOccurredAt, '2026-11-09T12:00:00Z');
assert.equal(aggregateEventMetadata([], { maxReferencesPerCategory: 0 }).total, 0);
assert.deepEqual(aggregateEventMetadata([], {}), {
  total: 0, categories: [], firstOccurredAt: null, lastOccurredAt: null,
});
assert.throws(() => aggregateEventMetadata([], { maxReferencesPerCategory: -1 }), /0 to 100/);
assert.throws(() => aggregateEventMetadata([{ category: 'issue-comment', id: '1', body: 'x' }]),
  /unsupported field "body"/, 'aggregation re-validates metadata');
assert.equal(summarizeEventDigest(digest), '5 events: 2 issue comments, 1 PR review, 1 PR merged, 1 unclassified event');
assert.equal(summarizeEventDigest({ total: 0, categories: [], firstOccurredAt: null, lastOccurredAt: null }), '0 events');

// The digest is compact and content-free; the runtime embeds it into the
// `issue-orchestrator.ticket-event.v1` envelope (tested by ticket-runtime).
const digestWire = JSON.stringify(digest);
assert.doesNotMatch(digestWire, /"body"|"title"|"content"|"diff"/);
assert.match(digestWire, /"categories"/);
assert.equal(EVENT_NOTIFICATION_NOTE.includes('Metadata only'), true);

console.log('event metadata stays compact, categorized and content-free');
