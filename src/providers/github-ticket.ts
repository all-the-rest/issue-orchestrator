import { gh, ghJson } from './gh.js';
import type { TicketComment, TicketIssue, TicketPort } from './ticket-port.js';

type Driver = { json(args: string[]): unknown; run(args: string[]): unknown };
const cli: Driver = { json: (args) => ghJson(args), run: (args) => gh(args) };
const validProject = (p: string) => {
  if (typeof p !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p)) throw new Error('project must be owner/repository');
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
function comment(v: unknown): TicketComment {
  const c = record(v, 'comment');
  const author = authorLogin(c.user, 'comment');
  if (author === null) throw new Error('Invalid GitHub comment (stable id, body, author and timestamp required)');
  const id = stableId(c.id, 'comment');
  const body = requiredString(c.body, 'comment body');
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
    comments: i.comments.map(comment),
  };
}

export function createGithubTicketPort(driver: Driver = cli): TicketPort {
  const comments = (project: string, number: number) => {
    const v = driver.json(['api', '--paginate', '--slurp', `repos/${project}/issues/${number}/comments`]);
    if (!Array.isArray(v)) throw new Error('Invalid GitHub comments response');
    const values = v.every(Array.isArray) ? v.flat() : v;
    return values.map(comment);
  };
  return {
    async select(project, limit = 100) {
      validProject(project);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
      const v = driver.json(['issue', 'list', '--repo', project, '--state', 'open', '--limit', String(limit), '--json', 'id,number,title,body,author,labels,state,url,updatedAt']);
      if (!Array.isArray(v)) throw new Error('Invalid GitHub issue list response');
      return v.map((x) => {
        const i = record(x, 'issue');
        const id = stableId(i.id, 'issue');
        const number = issueNumber(i.number, 'issue');
        const title = requiredString(i.title, 'issue title');
        const body = nullableString(i.body, 'issue body') ?? '';
        const author = authorLogin(i.author, 'issue');
        const labels = labelNames(i.labels, 'issue');
        const state = requiredString(i.state, 'issue state');
        const url = requiredString(i.url, 'issue URL');
        const updatedAt = nullableString(i.updatedAt, 'issue update timestamp');
        return {
          id: String(id), number, title, body,
          author, labels,
          state, url, updatedAt, comments: [],
        };
      });
    },
    async read(project, number) {
      validProject(project);
      if (!Number.isInteger(number) || number < 1) throw new Error('issue number must be positive');
      const v = record(driver.json(['issue', 'view', String(number), '--repo', project, '--json', 'id,number,title,body,author,labels,state,url,updatedAt']), 'issue');
      const base = issue({ ...v, html_url: v.url, comments: [] });
      return { ...base, comments: comments(project, number) };
    },
    async updates(project, number, cursor) {
      validProject(project);
      if (cursor !== null && (typeof cursor !== 'string' || !cursor)) throw new Error('invalid update cursor');
      const all = comments(project, number);
      if (cursor === null) return { updates: all, nextCursor: all.at(-1)?.id ?? null };
      const at = all.findIndex((c) => c.id === cursor);
      if (at < 0) throw new Error(`Stored update cursor ${cursor} is absent; refusing to skip updates`);
      const updates = all.slice(at + 1);
      return { updates, nextCursor: updates.at(-1)?.id ?? cursor };
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
