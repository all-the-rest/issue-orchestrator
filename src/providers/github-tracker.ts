import { gh, ghJson, verifyGithubAccount } from './gh.js';
import {
  descriptor,
  UnsupportedCapabilityError,
  type ProviderComment,
  type ProviderLabel,
  type Tracker,
  type WorkItem,
} from './ports.js';

export const githubTracker: Tracker = {
  name: 'github',
  capabilities: descriptor('github', 'Tracker', {
    workItems: true, labels: true, comments: true,
  }),
  verifyAccount: verifyGithubAccount,
  listWorkItems({ project, limit = 100 }) {
    return ghJson<WorkItem[]>([
      'issue', 'list', '--repo', project, '--state', 'open', '--limit', String(limit),
      '--json', 'number,title,author,labels,createdAt,updatedAt,url',
    ]);
  },
  getWorkItem({ project, number }) {
    return ghJson<WorkItem>([
      'issue', 'view', String(number), '--repo', project,
      '--json', 'number,title,body,author,labels,comments,url,state',
    ]);
  },
  updateWorkItem({ project, number, fields }) {
    const args = ['issue', 'edit', String(number), '--repo', project];
    const keys = Object.keys(fields ?? {});
    if (keys.length === 0 || keys.some((key) => !['title', 'body'].includes(key))) {
      throw new UnsupportedCapabilityError('github', 'Tracker', 'updateWorkItem fields');
    }
    if ('title' in fields) {
      if (typeof fields.title !== 'string') throw new Error('GitHub work-item title must be a string');
      args.push('--title', fields.title);
    }
    if ('body' in fields) {
      if (typeof fields.body !== 'string') throw new Error('GitHub work-item body must be a string');
      args.push('--body', fields.body);
    }
    gh(args);
  },
  setLabels({ project, number, add = [], remove = [] }) {
    const args = ['issue', 'edit', String(number), '--repo', project];
    if (add.length) args.push('--add-label', add.join(','));
    if (remove.length) args.push('--remove-label', remove.join(','));
    if (add.length || remove.length) gh(args);
  },
  getComments({ project, number }) {
    return ghJson<{ comments?: ProviderComment[] }>([
      'issue', 'view', String(number), '--repo', project, '--json', 'comments',
    ]).comments ?? [];
  },
  publishComment({ project, number, body }) {
    if (/<!--\s*(?:git-issue-agent:[a-z-]+|issue-orchestrator:idempotency=)/.test(body)) {
      const comments = ghJson<{ comments?: ProviderComment[] }>([
        'issue', 'view', String(number), '--repo', project, '--json', 'comments',
      ]).comments ?? [];
      if (comments.some((comment) => comment.body === body)) {
        return { skipped: true, reason: 'identical marker comment already exists' };
      }
    }
    gh(['issue', 'comment', String(number), '--repo', project, '--body', body]);
    return { skipped: false };
  },
  hasLabel({ project, name }) {
    const labels = ghJson<ProviderLabel[]>(['label', 'list', '--repo', project, '--limit', '1000', '--json', 'name']);
    return Array.isArray(labels) && labels.some((label) => label.name === name);
  },
  getLabel({ project, name }) {
    const labels = ghJson<ProviderLabel[]>([
      'label', 'list', '--repo', project, '--limit', '1000', '--json', 'name,color,description',
    ]);
    return Array.isArray(labels) ? labels.find((label) => label.name === name) ?? null : null;
  },
  ensureLabel({ project, name, color, description }) {
    gh(['label', 'create', name, '--repo', project, '--color', color, '--description', description, '--force']);
  },
};
