import { gh, ghJson, verifyGithubAccount } from './gh.js';
import { verifyOrigin } from '../git/index.js';
import {
  descriptor,
  type ChangeRequest,
  type CodeHost,
  type MergeMethod,
  type ProviderComment,
  type RequiredCheck,
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
  evidence_class: string;
  dod_report: Record<string, unknown>;
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
      if (snapshot.status !== 0 && snapshot.status !== 8) return { status: snapshot.status, checks: [] };
      const checks = parseChecks(snapshot.stdout);
      if (!checks || checks.length === 0) return { status: 1, checks: [] };
      const watched = gh([...args, '--watch', '--interval', String(interval)], { allowFail: true });
      if (watched.status !== 0 && watched.status !== 8) return { status: watched.status, checks };
      const finalSnapshot = gh([...args, '--json', 'bucket,name'], { allowFail: true });
      if (finalSnapshot.status !== 0 && finalSnapshot.status !== 8) {
        return { status: finalSnapshot.status, checks: [] };
      }
      const finalChecks = parseChecks(finalSnapshot.stdout);
      if (!finalChecks || finalChecks.length === 0) return { status: 1, checks: [] };
      return { status: finalSnapshot.status, checks: finalChecks };
    }

    const result = gh([...args, '--json', 'bucket,name'], { allowFail: true });
    if (result.status !== 0 && result.status !== 8) return { status: result.status, checks: [] };
    const checks = parseChecks(result.stdout);
    // An empty required-check set is not evidence of a green gate.
    if (!checks || checks.length === 0) return { status: 1, checks: [] };
    return { status: result.status, checks };
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
  verifyEvidence({ project, commit, issue, change, head, evidenceClass }) {
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
    if (manifestEntry.sha !== contents.sha || manifest.schema !== 2 || manifest.project !== project ||
        Number(manifest.issue) !== Number(issue) || Number(manifest.change) !== Number(change) || manifest.head !== head ||
        manifest.evidence_class !== evidenceClass || !manifest.dod_report ||
        manifest.dod_report.schema !== 1 || manifest.dod_report.project !== project ||
        Number(manifest.dod_report.issue) !== Number(issue) || manifest.dod_report.head_sha !== head ||
        manifest.dod_report.evidence_class !== evidenceClass || manifest.dod_report.overall !== 'passed') {
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

function parseChecks(text: string): RequiredCheck[] | null {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(value) || value.some((check) => !check || typeof check.name !== 'string' ||
      !check.name || typeof check.bucket !== 'string' || !check.bucket)) return null;
  return value;
}
