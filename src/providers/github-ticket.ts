import { gh, ghJson } from './gh.js';
import type {
  ActivationMentionRequest,
  ActivationScanRequest,
  ActivationScanResult,
  TicketComment,
  TicketIssue,
  TicketPort,
} from './ticket-port.js';

type Driver = { json(args: string[]): unknown; run(args: string[]): unknown; raw?(args: string[]): string };
const cli: Driver = { json: (args) => ghJson(args), run: (args) => gh(args), raw: (args) => gh(args).stdout };
const issueCommentMetadata = '[.[] | (if type == "array" then .[] else . end) | {id,user,created_at,html_url}]';
const activationCommentMetadata = '[.[] | {body,user:(if .user == null then null else {login:.user.login,type:.user.type} end)}]';
// Only fields that affect routing are requested. Reviews need `state` to skip
// drafts; path/line are never carried into TicketComment, so they are not
// fetched at all.
const reviewMetadata = '[.[] | (if type == "array" then .[] else . end) | {id,user,created_at,submitted_at,html_url,state}]';
const validProject = (p: string) => {
  if (typeof p !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p)) throw new Error('project must be owner/repository');
};
/** GitHub's maximum page size; smaller defaults multiply request/rate usage. */
const pagePath = (path: string) => `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
const MAX_PENDING_REVIEWS = 1_000;
const ACTIVATION_NEGATIVE_CACHE_MS = 30_000;
const MAX_ACTIVATION_CACHE_ENTRIES = 2_000;
/** GitHub's maximum page size for issue comments. */
const ACTIVATION_COMMENT_PAGE_SIZE = 100;
/** Absolute provider-side page bound, independent of any caller-supplied budget. */
const MAX_ACTIVATION_COMMENT_PAGES = 32;
/** Pages a legacy boolean check may read before failing closed as incomplete. */
const LEGACY_ACTIVATION_COMMENT_PAGES = 8;

const validGitHubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const containsCompleteMention = (text: string, login: string) => {
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_-])@${escaped}(?![A-Za-z0-9_-])`, 'i').test(text);
};
function record(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Invalid GitHub ${name} response`);
  return v as Record<string, unknown>;
}
function authorLogin(value: unknown, name: string): string | null {
  if (value === null) return null;
  const author = record(value, `${name} author`);
  if (typeof author.login !== 'string') throw new Error(`Invalid GitHub ${name} author`);
  return author.login;
}
function labelNames(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid GitHub ${name} labels`);
  return value.map((label) => {
    const item = record(label, `${name} label`);
    if (typeof item.name !== 'string') throw new Error(`Invalid GitHub ${name} label`);
    return item.name;
  });
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid GitHub ${name}`);
  return value;
}
/** gh prints one jq result per page when --paginate is combined with --jq. */
function jsonDocuments(text: string, name: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      throw new Error(`Invalid GitHub ${name} response`);
    }
  }
  return values;
}
/** Normalize slurped pages, per-page jq documents, and already-flat test fixtures. */
function responseValues(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid GitHub ${name} response`);
  return value.every(Array.isArray) ? value.flat() : value;
}
function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : requiredString(value, name);
}
function stableId(value: unknown, name: string): string | number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !String(value).trim()) throw new Error(`Invalid GitHub ${name} (stable id required)`);
  return value;
}
function issueNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`Invalid GitHub ${name} number`);
  return value;
}
function comment(v: unknown, includeBody = true): TicketComment {
  const c = record(v, 'comment');
  // GitHub reports null for a deleted author account; keep the event identity so
  // the router can filter it by trusted-author policy instead of replaying it.
  const author = authorLogin(c.user, 'comment');
  const id = stableId(c.id, 'comment');
  const body = includeBody ? requiredString(c.body, 'comment body') : '';
  const createdAt = requiredString(c.created_at, 'comment timestamp');
  return { id: String(id), body, author, createdAt, ...(typeof c.html_url === 'string' ? { url: c.html_url } : {}) };
}
function issue(v: unknown): TicketIssue {
  const i = record(v, 'issue');
  const id = stableId(i.id, 'issue');
  const number = issueNumber(i.number, 'issue');
  const title = requiredString(i.title, 'issue title');
  const body = nullableString(i.body, 'issue body') ?? '';
  const author = authorLogin(i.author, 'issue');
  const labels = labelNames(i.labels, 'issue');
  const state = requiredString(i.state, 'issue state');
  const url = requiredString(i.html_url, 'issue URL');
  const updatedAt = nullableString(i.updatedAt, 'issue update timestamp');
  if (!Array.isArray(i.comments)) throw new Error('Invalid GitHub issue comments');
  return {
    id: String(id), number, title, body,
    author, labels,
    state, url, updatedAt,
    comments: i.comments.map((entry) => comment(entry)),
  };
}

export function createGithubTicketPort(driver: Driver = cli): TicketPort {
  const activationCache = new Map<string, { updatedAt: string; matched: boolean; checkedAt: number }>();
  const issueListFields = 'id,number,author,state,url,updatedAt';
  const listIssues = (project: string, limit: number, search?: string) => {
    const args = ['issue', 'list', '--repo', project, '--state', 'open', '--limit', String(limit)];
    if (search) args.push('--search', search);
    args.push('--json', issueListFields);
    const v = driver.json(args);
    if (!Array.isArray(v)) throw new Error('Invalid GitHub issue list response');
    return v.map((x) => {
      const i = record(x, 'issue');
      const id = stableId(i.id, 'issue');
      const number = issueNumber(i.number, 'issue');
      const author = authorLogin(i.author, 'issue');
      const state = requiredString(i.state, 'issue state');
      const url = requiredString(i.url, 'issue URL');
      const updatedAt = nullableString(i.updatedAt, 'issue update timestamp');
      return {
        id: String(id), number, title: '', body: '',
        author, labels: [],
        state, url, updatedAt, comments: [],
      };
    });
  };
  const paginated = (path: string, name: string, expression: string) => {
    // gh rejects --slurp together with --jq; without --slurp it applies the jq
    // expression to every page and prints one JSON document per page. Ask for
    // the largest supported page so a busy PR needs fewer requests, which is
    // the main page/rate-limit safety lever available through the CLI.
    const args = ['api', '--paginate', '--jq', expression, pagePath(path)];
    const value = driver.raw ? jsonDocuments(driver.raw(args), name) : driver.json(args);
    return responseValues(value, name);
  };
  const slurped = (path: string, name: string) => {
    const value = driver.json(['api', '--paginate', '--slurp', pagePath(path)]);
    return responseValues(value, name);
  };
  const comments = (project: string, number: number, includeBody = true) => {
    const path = `repos/${project}/issues/${number}/comments`;
    return (includeBody ? slurped(path, 'comments') : paginated(path, 'comments', issueCommentMetadata))
      .map((value) => comment(value, includeBody));
  };
  /** Event ids repeat across GitHub collections; the type prefix keeps them distinct. */
  const changeComment = (value: unknown, name: string, prefix: string,
    timestamp: 'created' | 'submitted' = 'created'): TicketComment => {
    const c = record(value, name);
    const author = authorLogin(c.user, name);
    const id = stableId(c.id, name);
    const createdAt = timestamp === 'submitted'
      // A review's event time is when it was submitted; created_at is only the
      // draft start and would reorder late submissions incorrectly.
      ? (typeof c.submitted_at === 'string' ? c.submitted_at
        : typeof c.created_at === 'string' ? c.created_at : null)
      : (typeof c.created_at === 'string' ? c.created_at
        : typeof c.submitted_at === 'string' ? c.submitted_at : null);
    if (!createdAt) throw new Error(`Invalid GitHub ${name} timestamp`);
    return { id: `${prefix}:${String(id)}`, body: '', author, createdAt,
      ...(typeof c.html_url === 'string' ? { url: c.html_url } : {}) };
  };
  const idOf = (c: TicketComment) => {
    const match = /([0-9]+)$/.exec(c.id);
    return match ? Number(match[1]) : 0;
  };
  const activationCacheKey = (args: ActivationMentionRequest) => {
    const policy = [args.login,
      ...args.trustedAuthors.map((author) => author.toLocaleLowerCase()).sort(),
      '\u0000',
      ...args.excludedAuthors.map((author) => author.toLocaleLowerCase()).sort()].join('\u0000');
    return { key: `${args.project.toLocaleLowerCase()}#${args.number}\u0000${policy}`, policy };
  };
  const cacheActivation = (key: string, result: ActivationScanResult) => {
    // Same-process dedup only. The durable caller owns page progress, so an
    // incomplete scan is deliberately not cached as a negative result.
    if (!result.matched && !result.complete) return result;
    if (activationCache.size >= MAX_ACTIVATION_CACHE_ENTRIES && !activationCache.has(key)) {
      const oldest = activationCache.keys().next().value;
      if (oldest !== undefined) activationCache.delete(oldest);
    }
    activationCache.set(key, { updatedAt: result.revision, matched: result.matched, checkedAt: Date.now() });
    return result;
  };
  const activationCommentPage = (project: string, number: number, page: number) => {
    // A single page per request keeps the request count bounded. `--paginate`
    // would follow an attacker-controlled comment thread to its end.
    const path = `repos/${project}/issues/${number}/comments` +
      `?per_page=${ACTIVATION_COMMENT_PAGE_SIZE}&page=${page}`;
    const value = driver.json(['api', '--jq', activationCommentMetadata, path]);
    return responseValues(value, 'activation comments');
  };
  /**
   * Bounded newest-first comment scan. A durable caller passes `page` to
   * continue the descending historical cursor and `knownTop` to report the
   * newest page of the previous scan of this thread. Ordinary comments that
   * do not add a page therefore continue history instead of restarting at the
   * top; only a changed thread top restarts the descending range so a newly
   * added page cannot be skipped.
   */
  const scanActivation = (args: ActivationScanRequest): ActivationScanResult => {
    validProject(args.project);
    if (!Number.isInteger(args.number) || args.number < 1 || !validGitHubLogin.test(args.login)) {
      throw new Error('invalid activation request');
    }
    const issueData = record(driver.json([
      'api', '--jq', '{title,body,updated_at,comments}', `repos/${args.project}/issues/${args.number}`,
    ]), 'activation issue');
    const title = requiredString(issueData.title, 'activation issue title');
    const body = nullableString(issueData.body, 'activation issue body') ?? '';
    const revision = typeof issueData.updated_at === 'string' ? issueData.updated_at : '';
    const { key } = activationCacheKey(args);
    if (containsCompleteMention(title, args.login) || containsCompleteMention(body, args.login)) {
      return cacheActivation(key, { matched: true, complete: true, nextPage: null, revision, topPage: null });
    }
    const trustedAuthors = new Set(args.trustedAuthors.map((author) => author.toLocaleLowerCase()));
    const excludedAuthors = new Set(args.excludedAuthors.map((author) => author.toLocaleLowerCase()));
    const hasMention = (entries: unknown[]): boolean => {
      for (const entry of entries) {
        const row = record(entry, 'activation comment');
        const commentBody = requiredString(row.body, 'activation comment body');
        if (!row.user) continue;
        const user = record(row.user, 'activation comment author');
        const login = requiredString(user.login, 'activation comment author login');
        const normalized = login.toLocaleLowerCase();
        const isBot = user.type === 'Bot' || normalized.endsWith('[bot]');
        if (isBot || excludedAuthors.has(normalized) || !trustedAuthors.has(normalized)) continue;
        if (containsCompleteMention(commentBody, args.login)) return true;
      }
      return false;
    };
    const maxPages = Math.max(1, Math.min(args.maxPages ?? LEGACY_ACTIVATION_COMMENT_PAGES,
      MAX_ACTIVATION_COMMENT_PAGES));
    const commentCount = typeof issueData.comments === 'number' && Number.isSafeInteger(issueData.comments) &&
      issueData.comments >= 0 ? issueData.comments : null;
    if (commentCount === 0) {
      return cacheActivation(key, { matched: false, complete: true, nextPage: null, revision, topPage: null });
    }
    if (commentCount !== null) {
      const lastPage = Math.max(1, Math.ceil(commentCount / ACTIVATION_COMMENT_PAGE_SIZE));
      let remaining = maxPages;
      if (args.newest === true) {
        if (hasMention(activationCommentPage(args.project, args.number, lastPage))) {
          return cacheActivation(key, { matched: true, complete: true, nextPage: null, revision, topPage: lastPage });
        }
        remaining -= 1;
        if (lastPage === 1) {
          return cacheActivation(key, { matched: false, complete: true, nextPage: null, revision, topPage: lastPage });
        }
        if (remaining <= 0) {
          return cacheActivation(key, { matched: false, complete: false, nextPage: lastPage - 1, revision, topPage: lastPage });
        }
      }
      const savedPage = Number.isSafeInteger(args.page) && (args.page as number) > 0
        ? args.page as number : null;
      const savedTop = Number.isSafeInteger(args.knownTop) && (args.knownTop as number) > 0
        ? args.knownTop as number : null;
      // A previously completed scan proves every page up to `savedTop` was
      // read. Appends can only add pages above it and fill its last page, so a
      // revision change re-reads just that bounded newest range instead of the
      // whole (possibly 32-page) thread.
      const completedAbove = args.newest === true && args.resumeComplete === true &&
        savedTop !== null && lastPage >= savedTop;
      if (completedAbove) {
        const floor = savedTop as number;
        let page = lastPage - 1;
        while (remaining > 0 && page >= floor) {
          if (hasMention(activationCommentPage(args.project, args.number, page))) {
            return cacheActivation(key, { matched: true, complete: true, nextPage: null, revision, topPage: lastPage });
          }
          remaining -= 1;
          page -= 1;
        }
        if (page < floor) {
          return cacheActivation(key, { matched: false, complete: true, nextPage: null, revision, topPage: lastPage });
        }
        return cacheActivation(key, { matched: false, complete: false, nextPage: Math.max(1, page), revision, topPage: lastPage });
      }
      // Continue history only while the thread has the same newest page. A
      // newly appended page changes the top; the bounded range then restarts
      // so content above the old top cannot be skipped. Comments that only
      // update the newest page (ordinary activity) never reset the cursor.
      const resumable = savedPage !== null && savedTop === lastPage;
      let page = args.newest === true
        ? (resumable ? Math.min(savedPage, lastPage - 1) : lastPage - 1)
        // A historical continuation never re-reads the newest page: the caller
        // already inspected it for this revision.
        : (savedPage ?? Math.max(1, lastPage - 1));
      while (remaining > 0 && page >= 1) {
        if (hasMention(activationCommentPage(args.project, args.number, page))) {
          return cacheActivation(key, { matched: true, complete: true, nextPage: null, revision, topPage: lastPage });
        }
        remaining -= 1;
        if (page === 1) {
          return cacheActivation(key, { matched: false, complete: true, nextPage: null, revision, topPage: lastPage });
        }
        page -= 1;
      }
      return cacheActivation(key, { matched: false, complete: false, nextPage: Math.max(1, page), revision, topPage: lastPage });
    }
    // Provider fixtures or older responses may omit the comment count. Fall
    // back to ascending pages; a short page proves the end.
    let page = Number.isSafeInteger(args.page) && (args.page as number) > 0 ? args.page as number : 1;
    let remaining = maxPages;
    while (remaining > 0) {
      const entries = activationCommentPage(args.project, args.number, page);
      if (hasMention(entries)) {
        return cacheActivation(key, { matched: true, complete: true, nextPage: null, revision, topPage: null });
      }
      remaining -= 1;
      if (entries.length < ACTIVATION_COMMENT_PAGE_SIZE) {
        return cacheActivation(key, { matched: false, complete: true, nextPage: null, revision, topPage: null });
      }
      page += 1;
    }
    return cacheActivation(key, { matched: false, complete: false, nextPage: page, revision, topPage: null });
  };
  return {
    async select(project, limit = 100) {
      validProject(project);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
      return listIssues(project, limit);
    },
    async selectMentioned(project, login, limit = 100) {
      validProject(project);
      if (!validGitHubLogin.test(login)) throw new Error('activation login must be a GitHub login');
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be between 1 and 1000');
      // GitHub search indexes title/body/comment mentions regardless of the
      // bounded open-issue listing window. The result is advisory: the
      // per-issue activation check still verifies the trusted comment author.
      return listIssues(project, limit, `is:issue mentions:${login}`);
    },
    async identity(project, number) {
      validProject(project);
      if (!Number.isInteger(number) || number < 1) throw new Error('issue number must be positive');
      const v = record(driver.json(['issue', 'view', String(number), '--repo', project, '--json', 'number,author,state,url']), 'issue identity');
      const actualNumber = issueNumber(v.number, 'issue');
      if (actualNumber !== number) throw new Error('GitHub returned a mismatched issue identity');
      return {
        number: actualNumber,
        author: authorLogin(v.author, 'issue'),
        state: requiredString(v.state, 'issue state'),
        url: requiredString(v.url, 'issue URL'),
      };
    },
    async hasActivationMention(args: ActivationMentionRequest) {
      try {
        validProject(args.project);
        if (!Number.isInteger(args.number) || args.number < 1 || !validGitHubLogin.test(args.login)) {
          throw new Error('invalid activation request');
        }
        // The cache must not outlive the policy or the content revision.
        // Negative hits also expire because GitHub timestamps have second
        // precision: a comment added in the same second can keep updatedAt
        // unchanged, so an indefinite negative cache could miss a late mention.
        const { key } = activationCacheKey(args);
        const cached = activationCache.get(key);
        const cacheFresh = cached && typeof args.updatedAt === 'string' &&
          cached.updatedAt === args.updatedAt &&
          (cached.matched || Date.now() - cached.checkedAt < ACTIVATION_NEGATIVE_CACHE_MS);
        if (cacheFresh) return cached.matched;

        const result = scanActivation({
          ...args,
          newest: true,
          maxPages: LEGACY_ACTIVATION_COMMENT_PAGES,
        });
        if (!result.complete) {
          // A boolean API cannot represent "not yet known". Fail closed; the
          // bounded durable scan path continues from its saved page cursor.
          throw new Error('GitHub activation mention scan is incomplete');
        }
        return result.matched;
      } catch {
        // GitHub errors can include provider-controlled response text. Keep the
        // activation path's diagnostics content-free and fail closed.
        throw new Error('GitHub activation mention check failed');
      }
    },
    async scanActivationMention(args: ActivationScanRequest) {
      try {
        return scanActivation(args);
      } catch {
        // Never forward provider response text; it may contain ticket content.
        throw new Error('GitHub activation mention check failed');
      }
    },
    async read(project, number) {
      validProject(project);
      if (!Number.isInteger(number) || number < 1) throw new Error('issue number must be positive');
      const v = record(driver.json(['issue', 'view', String(number), '--repo', project, '--json', 'id,number,title,body,author,labels,state,url,updatedAt']), 'issue');
      const base = issue({ ...v, html_url: v.url, comments: [] });
      return { ...base, comments: comments(project, number, true) };
    },
    async updates(project, number, cursor) {
      validProject(project);
      if (cursor !== null && (typeof cursor !== 'string' || !cursor)) throw new Error('invalid update cursor');
      const all = comments(project, number, false);
      if (cursor === null) return { updates: all, nextCursor: all.at(-1)?.id ?? null };
      const at = all.findIndex((c) => c.id === cursor);
      if (at < 0) {
        // The cursor comment may have been deleted. Issue comment ids increase
        // monotonically, so numeric ids above the deleted cursor are still
        // exactly the not-yet-delivered events; never replay older history.
        if (/^[0-9]+$/.test(cursor)) {
          const floor = Number(cursor);
          const updates = all.filter((c) => /^[0-9]+$/.test(c.id) && Number(c.id) > floor);
          return { updates, nextCursor: updates.at(-1)?.id ?? cursor };
        }
        throw new Error(`Stored update cursor ${cursor} is absent; refusing to skip updates`);
      }
      const updates = all.slice(at + 1);
      return { updates, nextCursor: updates.at(-1)?.id ?? cursor };
    },
    async verifyChange(project, number) {
      validProject(project);
      if (!Number.isInteger(number) || number < 1) throw new Error('change number must be positive');
      const v = record(driver.json(['pr', 'view', String(number), '--repo', project, '--json', 'number,state,url']), 'change request');
      const actualNumber = issueNumber(v.number, 'change request');
      const state = requiredString(v.state, 'change request state');
      const url = requiredString(v.url, 'change request URL');
      if (actualNumber !== number || url.toLocaleLowerCase() !== `https://github.com/${project}/pull/${number}`.toLocaleLowerCase()) {
        throw new Error('GitHub returned a mismatched change request identity');
      }
      return { number: actualNumber, state, url };
    },
    async changeUpdates(project, number, cursor) {
      validProject(project);
      if (!Number.isInteger(number) || number < 1) throw new Error('change number must be positive');
      type ChangeCursor = {
        conversation: number;
        review: number;
        reviewComment: number;
        pendingReviews: number[];
        /** undefined means a legacy cursor without a submission watermark. */
        reviewSubmittedAt: string | null | undefined;
        /** Ids already observed at exactly reviewSubmittedAt, when known. */
        reviewSubmittedIds: number[];
        reviewSubmittedIdsKnown: boolean;
      };
      const parseCursor = (): ChangeCursor => {
        if (cursor === null) return {
          conversation: 0, review: 0, reviewComment: 0, pendingReviews: [], reviewSubmittedAt: undefined,
          reviewSubmittedIds: [], reviewSubmittedIdsKnown: false,
        };
        let value: unknown;
        try { value = JSON.parse(cursor); } catch { throw new Error('invalid change update cursor'); }
        const data = record(value, 'change cursor');
        const part = (key: string) => {
          const raw = data[key];
          if (raw === undefined) return 0;
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) throw new Error('invalid change update cursor');
          return raw;
        };
        const idList = (raw: unknown): number[] => {
          if (raw === undefined) return [];
          if (!Array.isArray(raw) || raw.length > MAX_PENDING_REVIEWS) {
            throw new Error('invalid change update cursor');
          }
          return raw.map((entry) => {
            const parsed = typeof entry === 'number' ? entry
              : typeof entry === 'string' && /^[1-9][0-9]*$/.test(entry) ? Number(entry) : NaN;
            if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('invalid change update cursor');
            return parsed;
          });
        };
        let reviewSubmittedAt: string | null | undefined;
        if (data.reviewSubmittedAt === undefined) reviewSubmittedAt = undefined;
        else if (data.reviewSubmittedAt === null) reviewSubmittedAt = null;
        else if (typeof data.reviewSubmittedAt === 'string' && Number.isFinite(Date.parse(data.reviewSubmittedAt))) {
          reviewSubmittedAt = data.reviewSubmittedAt;
        } else throw new Error('invalid change update cursor');
        return {
          conversation: part('conversation'), review: part('review'), reviewComment: part('reviewComment'),
          pendingReviews: idList(data.pendingReviews), reviewSubmittedAt,
          reviewSubmittedIds: idList(data.reviewSubmittedIds),
          reviewSubmittedIdsKnown: data.reviewSubmittedIds !== undefined,
        };
      };
      const last = parseCursor();
      const after = (list: TicketComment[], floor: number) => list.filter((c) => idOf(c) > floor);
      const conversation = after(paginated(`repos/${project}/issues/${number}/comments`, 'change comments',
        issueCommentMetadata).map((v) => changeComment(v, 'change comment', 'issue-comment')), last.conversation);
      const reviewComment = after(paginated(`repos/${project}/pulls/${number}/comments`, 'review comments',
        reviewMetadata).map((v) => changeComment(v, 'review comment', 'review-comment')), last.reviewComment);

      // Review ids increase with creation order, but a draft review created
      // before later submitted reviews can be submitted afterwards. Track the
      // pending ids and a submitted_at watermark so a late submission whose id
      // is below the numeric floor is still delivered exactly once.
      const pendingIds = new Set<number>(last.pendingReviews);
      const submittedReviews: Array<{ id: number; at: number; value: unknown }> = [];
      let maximumReviewId = last.review;
      let maximumSubmittedAt: string | null = null;
      let maximumSubmittedMs: number | null = null;
      for (const value of paginated(`repos/${project}/pulls/${number}/reviews`, 'reviews', reviewMetadata)) {
        const row = record(value, 'review');
        const rawId = stableId(row.id, 'review');
        const id = Number(rawId);
        if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid GitHub review id');
        maximumReviewId = Math.max(maximumReviewId, id);
        const submittedAt = typeof row.submitted_at === 'string' ? row.submitted_at : null;
        if (row.state === 'PENDING' || !submittedAt) {
          pendingIds.add(id);
          continue;
        }
        const at = Date.parse(submittedAt);
        if (!Number.isFinite(at)) throw new Error('Invalid GitHub review timestamp');
        submittedReviews.push({ id, at, value });
        if (maximumSubmittedMs === null || at > maximumSubmittedMs) {
          maximumSubmittedMs = at;
          maximumSubmittedAt = submittedAt;
        }
      }
      // Drop pending ids that are now submitted; keep any still unseen so a
      // transiently missing page cannot permanently lose a late submission.
      for (const review of submittedReviews) pendingIds.delete(review.id);
      if (pendingIds.size > MAX_PENDING_REVIEWS) {
        // Fail closed instead of silently dropping a tracked pending review.
        throw new Error('too many pending GitHub reviews to track safely');
      }
      // Legacy cursors carry no watermark. Their numeric floor cannot reveal
      // which lower-id draft reviews were skipped while pending, so replay
      // submitted reviews once on upgrade; the new cursor prevents repeats.
      const legacyCursor = last.reviewSubmittedAt === undefined;
      const previousBoundary = new Set(last.reviewSubmittedIds);
      const watermarkKnown = !legacyCursor && last.reviewSubmittedAt !== null;
      const watermarkMs = watermarkKnown ? Date.parse(last.reviewSubmittedAt as string) : null;
      const previousPending = new Set(last.pendingReviews);
      const review = submittedReviews
        .filter((entry) => {
          if (!watermarkKnown) return true; // one-time replay with no baseline
          if (entry.id > last.review || previousPending.has(entry.id)) return true;
          if (entry.at > watermarkMs!) return true;
          // A review submitted in the same second as the watermark is only
          // already seen if its id is recorded at that boundary. If boundary
          // ids are not known (cursor from an intermediate version), replay
          // this second once rather than silently skipping an unseen review.
          if (entry.at === watermarkMs) {
            return !last.reviewSubmittedIdsKnown || !previousBoundary.has(entry.id);
          }
          return false;
        })
        .sort((a, b) => a.at - b.at || a.id - b.id)
        .map((entry) => changeComment(entry.value, 'review', 'review', 'submitted'));

      const updates = [...conversation, ...reviewComment, ...review]
        .sort((a, b) => {
          const byTime = a.createdAt.localeCompare(b.createdAt);
          if (byTime) return byTime;
          const left = idOf(a);
          const right = idOf(b);
          return left !== right ? left - right : a.id.localeCompare(b.id);
        });
      let nextWatermark = last.reviewSubmittedAt !== undefined ? last.reviewSubmittedAt : null;
      if (maximumSubmittedAt &&
          (nextWatermark === null || Date.parse(maximumSubmittedAt) > Date.parse(nextWatermark))) {
        nextWatermark = maximumSubmittedAt;
      }
      const nextWatermarkMs = nextWatermark === null ? null : Date.parse(nextWatermark);
      let nextSubmittedIds: number[] = [];
      if (nextWatermarkMs !== null) {
        const atBoundary = submittedReviews.filter((entry) => entry.at === nextWatermarkMs).map((entry) => entry.id);
        // Keep already-known ids at an unchanged boundary so they are not
        // redelivered; add every id observed at a new boundary.
        nextSubmittedIds = watermarkKnown && nextWatermarkMs === watermarkMs
          ? [...new Set([...last.reviewSubmittedIds, ...atBoundary])]
          : [...new Set(atBoundary)];
      }
      if (nextSubmittedIds.length > MAX_PENDING_REVIEWS) {
        throw new Error('too many GitHub reviews at the submission boundary to track safely');
      }
      const next = {
        conversation: conversation.reduce((max, c) => Math.max(max, idOf(c)), last.conversation),
        // The floor includes pending ids; a later submission is recovered via
        // the pending set or watermark instead of the numeric floor.
        review: maximumReviewId,
        reviewComment: reviewComment.reduce((max, c) => Math.max(max, idOf(c)), last.reviewComment),
        pendingReviews: [...pendingIds].sort((a, b) => a - b),
        reviewSubmittedAt: nextWatermark,
        reviewSubmittedIds: nextSubmittedIds.sort((a, b) => a - b),
      };
      return { updates, nextCursor: JSON.stringify(next) };
    },
    async publishStatus(project, number, key, body) {
      validProject(project);
      if (!Number.isInteger(number) || number < 1 || !/^[A-Za-z0-9._-]{1,100}$/.test(key) ||
          typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 16_000 || /<!--\s*issue-orchestrator:status:/i.test(body)) {
        throw new Error('invalid status comment arguments');
      }
      const marker = `<!-- issue-orchestrator:status:${key} -->`;
      const existing = comments(project, number).find((c) => c.body.includes(marker));
      if (existing) return { id: existing.id, skipped: true };
      driver.run(['issue', 'comment', String(number), '--repo', project, '--body', `${body}\n\n${marker}`]);
      // Re-read after write; this also handles uncertain CLI outcomes on a later retry.
      const created = comments(project, number).find((c) => c.body.includes(marker));
      if (!created) throw new Error('Status comment write was not observable; retry with the same idempotency key');
      return { id: created.id, skipped: false };
    },
  };
}

export const githubTicket = createGithubTicketPort();
