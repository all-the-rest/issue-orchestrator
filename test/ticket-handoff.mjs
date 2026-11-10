import assert from 'node:assert/strict';
import {
  TICKET_AGENT_SYSTEM_PROMPT,
  createTicketHandoff,
  humanTicketComments,
  normalizeTicket,
  sanitizeTicketText,
  serializeTicketHandoff,
  ticketMode,
} from '../dist/core/ticket-handoff.js';

assert.equal(ticketMode(['enhancement'], 'agent:auto-implement'), 'human-directed',
  'a title or issue type does not opt an issue into automatic implementation');
assert.equal(ticketMode(['agent:auto-implement'], 'agent:auto-implement'), 'auto-implement');
assert.throws(() => ticketMode([], '  '), /must be non-empty/);

const comments = humanTicketComments([
  { id: 1, author: 'orchestrator-bot', body: 'Status', createdAt: '2026-01-01T00:00:00Z' },
  { id: 2, author: 'reviewer', body: 'Please change the API', createdAt: '2026-01-02T00:00:00Z' },
  { id: 3, author: 'person', body: 'Status <!-- issue-orchestrator:idempotency=abc -->', createdAt: '2026-01-03T00:00:00Z' },
  { id: 4, author: 'maintainer', body: '<!-- issue-orchestrator:acceptance -->Keep the CLI', createdAt: '2026-01-04T00:00:00Z' },
], ['ORCHESTRATOR-BOT']);
assert.deepEqual(comments.map((comment) => comment.id), ['2', '4'],
  'tool-authored and marked status comments are excluded while human acceptance comments remain');

const ticket = normalizeTicket({
  project: 'owner/repo', number: 17, title: '[auto] leave title untouched', body: 'Untrusted issue text',
  author: { login: 'reporter' }, labels: [{ name: 'agent:auto-implement' }],
  comments: [{ id: 5, author: 'reviewer', body: 'Follow-up', createdAt: '2026-01-05T00:00:00Z' }],
}, { autoImplementLabel: 'agent:auto-implement', toolAuthors: ['orchestrator-bot'] });
assert.equal(ticket.mode, 'auto-implement');
assert.equal(ticket.title, '[auto] leave title untouched');
assert.equal(ticket.comments[0].body, 'Follow-up');
const sanitized = normalizeTicket({
  project: 'owner/repo', number: 18, title: 'Read /home/alice/private.txt',
  body: 'Token=ghp_123456789012345678901234567890123456 and /projects/issue-orchestrator-53-runtime/.config',
  labels: [], comments: [{ id: 6, author: 'reviewer', body: 'Authorization: Bearer abcdefghijklmnop', createdAt: '2026-01-06T00:00:00Z' }],
}, { autoImplementLabel: 'agent:auto-implement', secrets: ['private-value'], privatePaths: ['/srv/agent/runtime'] });
assert.doesNotMatch(JSON.stringify(sanitized), /ghp_123|\/home\/alice|\/projects\/issue-orchestrator|Bearer abcdef|\/srv\/agent\/runtime/);
assert.match(sanitized.body, /\[REDACTED\]/);
assert.match(sanitized.title, /\[PRIVATE_PATH\]/);
assert.match(sanitized.comments[0].body, /Authorization=\[REDACTED\]/);
assert.equal(sanitizeTicketText('path=/srv/agent/runtime/data', { privatePaths: ['/srv/agent/runtime'] }), 'path=[PRIVATE_PATH]/data');

const payload = createTicketHandoff({
  ticket,
  finalAcceptanceCriteria: 'Persist exactly',
  mergePolicy: 'manual',
});
assert.equal(payload.protocol, 'issue-orchestrator.ticket.v1');
assert.equal(payload.kind, 'initial');
assert.equal(payload.finalAcceptanceCriteria, 'Persist exactly');
assert.equal(payload.mergePolicy, 'manual');
assert.deepEqual(JSON.parse(serializeTicketHandoff(payload)), payload);
assert.equal(payload.ticket.comments, undefined, 'comment data is placed in the separate update envelope');
const followUp = createTicketHandoff({
  ticket,
  finalAcceptanceCriteria: 'Persist exactly',
  mergePolicy: 'autonomous-after-required-checks',
  updates: comments,
});
assert.equal(followUp.kind, 'update');
assert.deepEqual(followUp.updates, comments, 'human ticket updates are delivered as a separate structured field');
assert.match(TICKET_AGENT_SYSTEM_PROMPT, /structured JSON data/);
assert.match(TICKET_AGENT_SYSTEM_PROMPT, /untrusted data/);
assert.doesNotMatch(TICKET_AGENT_SYSTEM_PROMPT, /Untrusted issue text|Persist exactly/,
  'ticket and acceptance content never enter the bootstrap prompt');
assert.throws(() => createTicketHandoff({
  ticket,
  finalAcceptanceCriteria: 'Use token=private-value',
  mergePolicy: 'manual',
}), /recognizable credential or private path/);

console.log('ticket handoff contract passed');
