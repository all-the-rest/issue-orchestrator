import { gh, ghJson } from './gh.js';
import type { TicketComment, TicketIssue, TicketPort } from './ticket-port.js';

type Driver = { json(args: string[]): unknown; run(args: string[]): unknown };
const cli: Driver = { json: (args) => ghJson(args), run: (args) => gh(args) };
const validProject = (p: string) => {
  if (typeof p !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p)) throw new Error('project must be owner/repository');
};
function record(v: unknown, name: string): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Invalid GitHub ${name} response`);
  return v as Record<string, any>;
}
function comment(v: unknown): TicketComment {
  const c = record(v, 'comment');
  const id = c.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || !String(id).trim() || typeof c.body !== 'string' ||
      typeof c.created_at !== 'string' || typeof c.user?.login !== 'string') throw new Error('Invalid GitHub comment (stable id, body, author and timestamp required)');
  return { id: String(id), body: c.body, author: c.user.login, createdAt: c.created_at, ...(typeof c.html_url === 'string' ? { url: c.html_url } : {}) };
}
function issue(v: unknown): TicketIssue {
  const i = record(v, 'issue');
  if ((typeof i.id !== 'number' && typeof i.id !== 'string') || !Number.isInteger(i.number) || typeof i.title !== 'string' ||
      (typeof i.body !== 'string' && i.body !== null) || typeof i.state !== 'string' || typeof i.html_url !== 'string' || !Array.isArray(i.comments) ||
      (i.author !== null && typeof i.author?.login !== 'string') || !Array.isArray(i.labels) ||
      i.labels.some((label: unknown) => !label || typeof label !== 'object' || typeof (label as Record<string, unknown>).name !== 'string') ||
      (i.updatedAt !== null && typeof i.updatedAt !== 'string')) {
    throw new Error('Invalid GitHub issue response');
  }
  return {
    id: String(i.id), number: i.number, title: i.title, body: i.body ?? '',
    author: typeof i.author?.login === 'string' ? i.author.login : null,
    labels: i.labels.map((label: { name: string }) => label.name),
    state: i.state, url: i.html_url, updatedAt: i.updatedAt ?? null,
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
        if ((typeof i.id !== 'number' && typeof i.id !== 'string') || !Number.isInteger(i.number) || typeof i.title !== 'string' ||
            (typeof i.body !== 'string' && i.body !== null) || typeof i.state !== 'string' || typeof i.url !== 'string' ||
            (i.author !== null && typeof i.author?.login !== 'string') || !Array.isArray(i.labels) ||
            i.labels.some((label: unknown) => !label || typeof label !== 'object' || typeof (label as Record<string, unknown>).name !== 'string') ||
            (i.updatedAt !== null && typeof i.updatedAt !== 'string')) throw new Error('Invalid GitHub issue list item');
        return {
          id: String(i.id), number: i.number, title: i.title, body: i.body ?? '',
          author: typeof i.author?.login === 'string' ? i.author.login : null,
          labels: i.labels.map((label: { name: string }) => label.name),
          state: i.state, url: i.url, updatedAt: i.updatedAt ?? null, comments: [],
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
