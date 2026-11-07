import { gh, ghJson, verifyGithubAccount } from './gh.js';
import { verifyOrigin } from '../git/index.js';
import {
  descriptor,
  type ChangeRequest,
  type CodeHost,
  type MergeMethod,
  type ProviderComment,
} from './ports.js';

const MERGE_FLAGS: Record<MergeMethod, string> = { squash: '--squash', merge: '--merge', rebase: '--rebase' };
const CHANGE_LOOKUP_LIMIT = 1000;

interface ChangeListEntry {
  number: number;
  url?: string;
  headRefName: string;
  baseRefName: string;
  state?: string;
}

interface GithubTreeEntry {
  path: string;
  type: string;
  mode: string;
  sha: string;
  size?: number;
}

interface GithubTreeResponse {
  truncated: boolean;
  tree?: GithubTreeEntry[];
}

interface GithubContentsResponse {
  sha: string;
  encoding: string;
  content?: string;
}

interface EvidenceFile {
  name: string;
  sha: string;
  bytes: number;
  source?: string;
}

interface EvidenceManifest {
  [key: string]: unknown;
  schema: number;
  project: string;
  issue: number;
  change: number;
  head: string;
  files: EvidenceFile[];
}

export const githubCodeHost: CodeHost = {
  name: 'github',
  capabilities: descriptor('github', 'CodeHost', {
    changes: true, checks: true, nativeApproval: true,
    mergeMethods: ['squash', 'merge', 'rebase'], evidence: 'branch+raw-url', repositoryVerification: true,
  }),
  verifyAccount: verifyGithubAccount,
  verifyRepository({ project }) {
    return verifyOrigin(project);
  },
  getChange({ project, number }) {
    return ghJson<ChangeRequest>([
      'pr', 'view', String(number), '--repo', project,
      '--json', 'number,state,isDraft,url,headRefName,headRefOid,baseRefName,baseRefOid,body,author,comments,reviews,reviewDecision,mergeable,mergeStateStatus',
    ]);
  },
  getReviewStatus({ project, number }) {
    const change = githubCodeHost.getChange({ project, number });
    return {
      decision: change.reviewDecision ?? null,
      reviews: change.reviews ?? [],
      author: change.author ?? null,
      head: change.headRefOid ?? null,
    };
  },
  findChange({ project, head, base }) {
    const existing = ghJson<ChangeListEntry[]>([
      'pr', 'list', '--repo', project, '--head', head, '--base', base, '--state', 'all',
      '--limit', String(CHANGE_LOOKUP_LIMIT),
      '--json', 'number,url,headRefName,baseRefName,state',
    ]);
    if (!Array.isArray(existing)) throw new Error('GitHub returned an invalid change-request list');
    // A full page at this safety cap may be truncated, so it is not safe to infer uniqueness.
    if (existing.length >= CHANGE_LOOKUP_LIMIT) {
      throw new Error(`change-request lookup reached ${CHANGE_LOOKUP_LIMIT} results; refusing a potentially truncated match set`);
    }
    const matches = existing.filter((change) => change.headRefName === head && change.baseRefName === base);
    if (matches.length > 1) throw new Error(`multiple change requests match ${head} -> ${base}; refusing ambiguous reuse`);
    if (matches.length === 0) return null;
    const [match] = matches;
    if (match.state !== 'OPEN') {
      throw new Error(`matching change request #${match.number} is ${match.state ?? 'in an unknown state'}; refusing duplicate creation`);
    }
    return { url: match.url ?? null, number: match.number, head, base, state: match.state, reused: true };
  },
  getChecks({ project, number, required = true, watch = false, interval = 10 }) {
    const args = ['pr', 'checks', String(number), '--repo', project];
    if (required) args.push('--required');

    if (watch) {
      // gh does not support --watch and --json together. Prove the required-check
      // set is nonempty, then let gh watch using its exit code.
      const snapshot = gh([...args, '--json', 'bucket,name'], { allowFail: true });
      if (snapshot.status !== 0 && snapshot.status !== 8) return snapshot.status;
      let checks;
      try { checks = JSON.parse(snapshot.stdout); } catch { return 1; }
      if (!Array.isArray(checks) || checks.length === 0) return 1;
      return gh([...args, '--watch', '--interval', String(interval)], { allowFail: true }).status;
    }

    const result = gh([...args, '--json', 'bucket,name'], { allowFail: true });
    if (result.status !== 0 && result.status !== 8) return result.status;
    let checks;
    try { checks = JSON.parse(result.stdout); } catch { return 1; }
    // An empty required-check set is not evidence of a green gate.
    if (!Array.isArray(checks) || checks.length === 0) return 1;
    return result.status;
  },
  merge({ project, number, method = 'squash', headSha }) {
    const flag = MERGE_FLAGS[method];
    if (!flag) throw new Error(`Unsupported merge method "${method}" (use squash, merge or rebase)`);
    if (!/^[a-f0-9]{40}$/i.test(headSha ?? '')) throw new Error('merge requires an expected full head SHA');
    gh(['pr', 'merge', String(number), '--repo', project, flag, '--delete-branch', '--match-head-commit', headSha]);
    return { method };
  },
  createChange({ project, head, base, title, bodyFile, draft = false }) {
    const existing = githubCodeHost.findChange({ project, head, base });
    if (existing) return existing;
    const args = ['pr', 'create', '--repo', project, '--head', head, '--base', base, '--title', title, '--body-file', bodyFile];
    if (draft) args.push('--draft');
    const output = gh(args).stdout;
    const url = output.split('\n').map((line) => line.trim()).find((line) => line.startsWith('https://'));
    const number = url ? Number(url.match(/\/(?:pull|pulls)\/(\d+)/)?.[1] ?? 0) || null : null;
    return { url: url ?? null, number, head, base, reused: false };
  },
  publishComment({ project, number, body }) {
    if (/<!--\s*(?:git-issue-agent:[a-z-]+|issue-orchestrator:idempotency=)/.test(body)) {
      const comments = ghJson<{ comments?: ProviderComment[] }>([
        'pr', 'view', String(number), '--repo', project, '--json', 'comments',
      ]).comments ?? [];
      if (comments.some((comment) => comment.body === body)) {
        return { skipped: true, reason: 'identical marker comment already exists' };
      }
    }
    gh(['pr', 'comment', String(number), '--repo', project, '--body', body]);
    return { skipped: false };
  },
  verifyEvidence({ project, commit, issue, change, head }) {
    if (!/^[a-f0-9]{40}$/i.test(commit ?? '')) throw new Error('evidence commit must be a full SHA');
    const tree = ghJson<GithubTreeResponse>(['api', `repos/${project}/git/trees/${commit}?recursive=1`]);
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('evidence tree is unavailable or truncated');
    const manifestEntry = tree.tree.find((entry) => entry.path === 'manifest.json' && entry.type === 'blob');
    if (!manifestEntry || manifestEntry.mode !== '100644') throw new Error('evidence commit has no regular manifest.json blob');
    const contents = ghJson<GithubContentsResponse>(['api', `repos/${project}/contents/manifest.json?ref=${commit}`]);
    if (contents.encoding !== 'base64' || typeof contents.content !== 'string') {
      throw new Error('evidence manifest is not available as a GitHub blob');
    }
    let manifest: EvidenceManifest;
    try { manifest = JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8')) as EvidenceManifest; }
    catch { throw new Error('evidence manifest is invalid JSON'); }
    if (manifestEntry.sha !== contents.sha || manifest.schema !== 1 || manifest.project !== project ||
        Number(manifest.issue) !== Number(issue) || Number(manifest.change) !== Number(change) || manifest.head !== head) {
      throw new Error('evidence manifest does not match this project, issue, change request and exact head SHA');
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('evidence manifest has no artifacts');
    const byPath = new Map<string, GithubTreeEntry>(tree.tree.map((entry) => [entry.path, entry]));
    const sides = new Set<string>();
    for (const file of manifest.files) {
      const entry = byPath.get(file.name);
      if (!entry || entry.type !== 'blob' || entry.mode !== '100644' || entry.sha !== file.sha ||
          !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || entry.size !== file.bytes ||
          !/^[a-f0-9]{40}$/i.test(file.sha ?? '')) {
        throw new Error(`evidence artifact is missing or does not match its manifest: ${file.name}`);
      }
      if (typeof file.source === 'string') sides.add(file.source.split('/')[0]);
    }
    if (!sides.has('before') || !sides.has('after')) throw new Error('evidence manifest must include artifacts from before/ and after/');
    return { commit, manifest, files: manifest.files.length };
  },
  evidenceUrl({ project, ref, path: filePath }) {
    return `https://raw.githubusercontent.com/${project}/${ref}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  },
};
