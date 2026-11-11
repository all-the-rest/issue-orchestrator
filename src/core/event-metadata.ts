/**
 * Compact, metadata-only ticket event notifications.
 *
 * The router tells the agent that activity happened, where it happened and how
 * many events of each category were observed. It never forwards issue text,
 * comment/review bodies, diffs or other content: the agent fetches details with
 * its own GitHub access. Categories are only assigned when the provider data
 * proves them; anything else is `unclassified` and keeps the raw source label.
 */

export const EVENT_CATEGORIES = [
  'issue-created',
  'issue-edited',
  'issue-comment',
  'pr-conversation',
  'pr-review',
  'pr-review-comment',
  'pr-merge',
  'pr-closed',
  'pr-state-changed',
  'unclassified',
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(EVENT_CATEGORIES);

export const EVENT_CATEGORY_LABELS: Record<EventCategory, string> = {
  'issue-created': 'issue created',
  'issue-edited': 'issue text edited',
  'issue-comment': 'issue comment',
  'pr-conversation': 'PR conversation comment',
  'pr-review': 'PR review',
  'pr-review-comment': 'PR inline review comment',
  'pr-merge': 'PR merged',
  'pr-closed': 'PR closed',
  'pr-state-changed': 'PR state changed',
  unclassified: 'unclassified event',
};

export const EVENT_CATEGORY_PLURALS: Record<EventCategory, string> = {
  'issue-created': 'issues created',
  'issue-edited': 'issue text edits',
  'issue-comment': 'issue comments',
  'pr-conversation': 'PR conversation comments',
  'pr-review': 'PR reviews',
  'pr-review-comment': 'PR inline review comments',
  'pr-merge': 'PR merges',
  'pr-closed': 'PR closures',
  'pr-state-changed': 'PR state changes',
  unclassified: 'unclassified events',
};

/** Only these fields may cross the notification boundary. */
const ALLOWED_KEYS = new Set(['category', 'id', 'url', 'occurredAt', 'source', 'fields']);

export interface EventMetadata {
  category: EventCategory;
  /** Stable provider event identity; used for dedupe, never rendered as content. */
  id: string;
  /** Provider link so the agent can fetch the event itself. */
  url?: string;
  /** Provider timestamp when known (ISO-8601). */
  occurredAt?: string;
  /** Raw provider source for `unclassified` events, so certainty is not invented. */
  source?: string;
  /** Names of changed fields only; never their values. */
  fields?: string[];
}

export interface EventReference {
  id: string;
  url?: string;
}

export interface EventDigestCategory {
  category: EventCategory;
  /** Full count, even when `references` is bounded. */
  count: number;
  references: EventReference[];
  /** Raw provider sources retained for unclassified events. */
  sources?: string[];
  /** Changed field names only. */
  fields?: string[];
}

export interface EventDigest {
  total: number;
  categories: EventDigestCategory[];
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  // eslint-disable-next-line no-control-regex -- reject control characters in persisted metadata
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must not contain control characters`);
  if (value.length > max) throw new Error(`${label} must be at most ${max} characters`);
  return value;
}

function optionalHttpUrl(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = safeString(value, label, 1000);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${label} must be an absolute URL`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${label} must be an HTTP(S) URL`);
  return text;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = safeString(value, label, 100);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be a parseable timestamp`);
  return text;
}

function optionalFields(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array of field names`);
  const fields = value.map((entry, index) => safeString(entry, `${label}[${index}]`, 100));
  return [...new Set(fields)].sort();
}

/**
 * Validate and copy metadata, rejecting every non-whitelisted field. This is
 * the boundary that keeps issue/comment/review bodies out of a notification:
 * an accidental `body`, `title` or `content` property fails instead of leaking.
 */
export function normalizeEventMetadata(value: unknown, label = 'event'): EventMetadata {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`${label} has unsupported field "${key}"; only metadata may be forwarded`);
    }
  }
  if (typeof value.category !== 'string' || !CATEGORY_SET.has(value.category)) {
    throw new Error(`${label}.category must be one of ${EVENT_CATEGORIES.join(', ')}`);
  }
  const event: EventMetadata = {
    category: value.category as EventCategory,
    id: safeString(value.id, `${label}.id`),
  };
  const url = optionalHttpUrl(value.url, `${label}.url`);
  if (url) event.url = url;
  const occurredAt = optionalTimestamp(value.occurredAt, `${label}.occurredAt`);
  if (occurredAt) event.occurredAt = occurredAt;
  if (value.source !== undefined && value.source !== null) {
    event.source = safeString(value.source, `${label}.source`, 100);
  }
  const fields = optionalFields(value.fields, `${label}.fields`);
  if (fields) event.fields = fields;
  if (event.category !== 'unclassified') delete event.source;
  return event;
}

/**
 * Classify a ticket update using only facts already parsed by the provider.
 * `change` alone cannot distinguish a PR conversation comment from a review,
 * so it stays unclassified rather than guessing.
 */
export function classifyTicketEvent(event: { id: string; source?: string | null }): EventCategory | null {
  if (event.source === 'operator') return null;
  const id = event.id;
  if (id.startsWith('review-comment:')) return 'pr-review-comment';
  if (id.startsWith('review:')) return 'pr-review';
  if (id.startsWith('issue-comment:')) return 'pr-conversation';
  if (event.source === 'ticket') return 'issue-comment';
  if (event.source === 'change') return 'unclassified';
  return 'unclassified';
}

/**
 * Convert one already-trusted ticket update into metadata. The input may carry
 * a body; it is ignored and never copied. Operator criteria are not GitHub
 * activity and produce no event.
 */
export function metadataFromTicketUpdate(
  update: { id: string; source?: string | null; url?: string | null; createdAt?: string | null },
): EventMetadata | null {
  const category = classifyTicketEvent(update);
  if (!category) return null;
  return normalizeEventMetadata({
    category,
    id: update.id,
    ...(update.url ? { url: update.url } : {}),
    ...(update.createdAt ? { occurredAt: update.createdAt } : {}),
    ...(category === 'unclassified' && update.source ? { source: update.source } : {}),
  });
}

/**
 * Build metadata for an issue creation the provider actually observed, such as
 * an `opened` webhook event. Polling discovery is not creation: the first poll
 * sees an issue that may have existed for a long time, so callers must not use
 * this helper for a freshly discovered ticket. The current GitHub polling path
 * therefore never emits `issue-created`.
 */
export function issueCreatedMetadata(input: {
  id: string; url?: string | null; occurredAt?: string | null;
}): EventMetadata {
  return normalizeEventMetadata({
    category: 'issue-created',
    id: input.id,
    ...(input.url ? { url: input.url } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
}

/**
 * Issue text edits qualify only when the provider proves the editor and the
 * caller has verified that editor against the trusted allowlist. A title/body
 * snapshot difference alone does not prove who edited the issue, so this
 * returns null rather than inventing an actor or a trusted event.
 */
export function issueEditedMetadata(input: {
  id: string;
  fields: string[];
  actor?: string | null;
  trustedAuthors?: string[];
  url?: string | null;
  occurredAt?: string | null;
}): EventMetadata | null {
  const fields = [...new Set(input.fields.filter((field) => field === 'title' || field === 'body'))].sort();
  if (fields.length === 0) return null;
  const actor = input.actor?.trim().toLocaleLowerCase();
  const trusted = new Set((input.trustedAuthors ?? []).map((author) => author.trim().toLocaleLowerCase()));
  if (!actor || !trusted.has(actor)) return null;
  return normalizeEventMetadata({
    category: 'issue-edited',
    id: input.id,
    fields,
    ...(input.url ? { url: input.url } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
}

/**
 * Classify an associated-PR state transition. `null` means "no event": an
 * unchanged state, or first association while still OPEN, is not activity.
 */
export function classifyPullRequestTransition(previousState: string | null, nextState: string): EventCategory | null {
  const next = nextState.trim().toLocaleUpperCase();
  if (!previousState) return next === 'OPEN' ? null : next === 'MERGED' ? 'pr-merge'
    : next === 'CLOSED' ? 'pr-closed' : 'pr-state-changed';
  const previous = previousState.trim().toLocaleUpperCase();
  if (previous === next) return null;
  if (next === 'MERGED') return 'pr-merge';
  if (next === 'CLOSED') return 'pr-closed';
  return 'pr-state-changed';
}

/**
 * Build a PR transition notification. The caller supplies the stable event id
 * (for example from the provider transition it observed) so reopen/close cycles
 * are not collapsed into one identity.
 */
export function pullRequestTransitionMetadata(input: {
  id: string;
  previousState: string | null;
  state: string;
  url?: string | null;
  occurredAt?: string | null;
}): EventMetadata | null {
  const category = classifyPullRequestTransition(input.previousState, input.state);
  if (!category) return null;
  return normalizeEventMetadata({
    category,
    id: input.id,
    ...(input.url ? { url: input.url } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
}

function occurredRange(events: EventMetadata[]): { first: string | null; last: string | null } {
  let first: { text: string; time: number } | null = null;
  let last: { text: string; time: number } | null = null;
  for (const event of events) {
    if (!event.occurredAt) continue;
    const time = Date.parse(event.occurredAt);
    if (!Number.isFinite(time)) continue;
    if (!first || time < first.time) first = { text: event.occurredAt, time };
    if (!last || time > last.time) last = { text: event.occurredAt, time };
  }
  return { first: first?.text ?? null, last: last?.text ?? null };
}

/**
 * Aggregate event metadata into per-category counts in first-seen order.
 * Duplicate event identities are counted once. References are bounded to keep
 * the notification compact; the full `count` is always retained so the agent
 * knows how much activity occurred.
 */
export function aggregateEventMetadata(
  events: EventMetadata[],
  options: { maxReferencesPerCategory?: number } = {},
): EventDigest {
  const maxReferences = options.maxReferencesPerCategory ?? 20;
  if (!Number.isSafeInteger(maxReferences) || maxReferences < 0 || maxReferences > 100) {
    throw new Error('maxReferencesPerCategory must be an integer from 0 to 100');
  }
  const normalized = events.map((event, index) => normalizeEventMetadata(event, `events[${index}]`));
  const categories = new Map<EventCategory, EventDigestCategory>();
  const seen = new Set<string>();
  for (const event of normalized) {
    const key = `${event.category}\u0000${event.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let category = categories.get(event.category);
    if (!category) {
      category = { category: event.category, count: 0, references: [] };
      categories.set(event.category, category);
    }
    category.count += 1;
    if (category.references.length < maxReferences) {
      category.references.push({ id: event.id, ...(event.url ? { url: event.url } : {}) });
    }
    if (event.source) {
      category.sources ??= [];
      if (!category.sources.includes(event.source)) category.sources.push(event.source);
    }
    if (event.fields?.length) {
      category.fields ??= [];
      for (const field of event.fields) if (!category.fields.includes(field)) category.fields.push(field);
    }
  }
  const range = occurredRange(normalized);
  return {
    total: seen.size,
    categories: [...categories.values()],
    firstOccurredAt: range.first,
    lastOccurredAt: range.last,
  };
}

export const EVENT_NOTIFICATION_NOTE = 'Metadata only: no issue, comment, review, diff or file content is included. Fetch details from GitHub yourself.';

/** One-line count summary for CLI/status output, e.g. `4 events: 3 issue comments, 1 PR merged`. */
export function summarizeEventDigest(digest: EventDigest): string {
  if (digest.total === 0) return '0 events';
  const parts = digest.categories.map((category) => {
    const label = category.count === 1
      ? EVENT_CATEGORY_LABELS[category.category]
      : EVENT_CATEGORY_PLURALS[category.category];
    return `${category.count} ${label ?? category.category}`;
  });
  return `${digest.total} event${digest.total === 1 ? '' : 's'}: ${parts.join(', ')}`;
}
