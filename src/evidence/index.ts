import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /(?:^|\n)\s*(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*['"]?[^\s'"#]{8,}/im,
];
const FORBIDDEN_NAME = /(^|\/)(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx|p8)|.*(?:secret|token|credential).*)$/i;
const DOTFILE = /(^|\/)(?:\.|[^/]+\/\.)[^/]+/;

function git(
  args: string[],
  { cwd, input, env, allowExitCodes = [] as number[] }: {
    cwd?: string;
    input?: string | Buffer;
    env?: Record<string, string>;
    allowExitCodes?: number[];
  } = {},
) {
  const result = spawnSync('git', args, {
    cwd,
    input,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowExitCodes.includes(result.status)) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function walk(root, current = root, out = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) walk(root, abs, out);
    else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
    else if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link evidence entry: ${path.relative(root, abs)}`);
    }
  }
  return out;
}

function kind(name) {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return 'image';
  if (/\.(mp4|webm|mov|mkv)$/i.test(name)) return 'video';
  if (/\.(log|txt|md|json)$/i.test(name)) return 'log';
  return 'file';
}

function assertNoSecrets(name, contents) {
  if (FORBIDDEN_NAME.test(name) || DOTFILE.test(name)) {
    throw new Error(`Refusing hidden or credential-like evidence file: ${name}`);
  }
  // Latin-1 preserves ASCII credential markers even inside image/video metadata.
  const text = contents.toString('latin1');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`Refusing evidence with credential-like content: ${name}`);
  }
}

function assertArtifactFormat(name, contents) {
  if (contents.length === 0) throw new Error(`Refusing empty evidence artifact: ${name}`);
  const lower = name.toLowerCase();
  const starts = (hex) => contents.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  if (lower.endsWith('.png') && !starts('89504e470d0a1a0a')) throw new Error(`Invalid PNG evidence artifact: ${name}`);
  if ((lower.endsWith('.jpg') || lower.endsWith('.jpeg')) && !starts('ffd8ff')) throw new Error(`Invalid JPEG evidence artifact: ${name}`);
  if (lower.endsWith('.gif') && !['GIF87a', 'GIF89a'].includes(contents.subarray(0, 6).toString('ascii'))) {
    throw new Error(`Invalid GIF evidence artifact: ${name}`);
  }
  if (lower.endsWith('.webp') && (contents.subarray(0, 4).toString('ascii') !== 'RIFF' || contents.subarray(8, 12).toString('ascii') !== 'WEBP')) {
    throw new Error(`Invalid WebP evidence artifact: ${name}`);
  }
  if (lower.endsWith('.svg') && !/<svg\b/i.test(contents.toString('utf8', 0, Math.min(contents.length, 8192)))) {
    throw new Error(`Invalid SVG evidence artifact: ${name}`);
  }
  if (['.mp4', '.mov'].some((ext) => lower.endsWith(ext)) && contents.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new Error(`Invalid MP4-family evidence artifact: ${name}`);
  }
  if (['.webm', '.mkv'].some((ext) => lower.endsWith(ext)) && !starts('1a45dfa3')) {
    throw new Error(`Invalid Matroska evidence artifact: ${name}`);
  }
}

export function verifyOrigin(project, root = git(['rev-parse', '--show-toplevel'])) {
  let remote;
  try {
    remote = git(['config', '--get', 'remote.origin.url'], { cwd: root });
  } catch {
    throw new Error('Evidence publishing requires a verified origin remote');
  }
  const match = remote.match(/^(?:https?:\/\/|ssh:\/\/git@)github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i) ??
    remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!match || match[1].toLowerCase() !== project.toLowerCase()) {
    throw new Error(`origin does not identify configured GitHub project ${project}; evidence was not published`);
  }
  const pushUrl = git(['remote', 'get-url', '--push', 'origin'], { cwd: root });
  const pushMatch = pushUrl.match(/^(?:https?:\/\/|ssh:\/\/git@)github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i) ??
    pushUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!pushMatch || pushMatch[1].toLowerCase() !== project.toLowerCase()) {
    throw new Error(`origin push URL does not identify configured GitHub project ${project}; refused`);
  }
  const canonical = `https://github.com/${project}.git`;
  const effectiveCanonical = git(['ls-remote', '--get-url', canonical], { cwd: root });
  if (effectiveCanonical !== canonical) {
    throw new Error('Git URL rewrite changes the configured evidence destination; refused');
  }
  const pushInsteadOf = git([
    'config', '--null', '--get-regexp', '^url\\..*\\.pushinsteadof$',
  ], { cwd: root, allowExitCodes: [1] });
  let longestMatch = null;
  for (const entry of pushInsteadOf.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\n');
    if (separator < 0) continue;
    const key = entry.slice(0, separator);
    const prefix = entry.slice(separator + 1);
    const match = key.match(/^url\.(.*)\.pushinsteadof$/i);
    if (!match || !canonical.startsWith(prefix)) continue;
    if (!longestMatch || prefix.length > longestMatch.prefix.length) {
      longestMatch = { base: match[1], prefix };
    }
  }
  const effectivePush = longestMatch
    ? `${longestMatch.base}${canonical.slice(longestMatch.prefix.length)}`
    : canonical;
  if (effectivePush !== canonical) {
    throw new Error('Git pushInsteadOf rewrite changes the configured evidence destination; refused');
  }
  return { remote, pushUrl };
}

/**
 * Publish immutable, SHA-pinned evidence linked to one issue, PR and source
 * head. The configured GitHub project is checked against origin; the push URL
 * itself is canonical and never inferred from an arbitrary remote.
 */
export function publishEvidence({
  project,
  issue,
  change,
  head,
  dir,
  branchPrefix = 'agent-evidence',
  rawUrl,
}) {
  if (!project || !Number.isSafeInteger(Number(issue)) || Number(issue) <= 0) {
    throw new Error('a project and positive issue number are required');
  }
  if (!Number.isSafeInteger(Number(change)) || Number(change) <= 0) {
    throw new Error('--change must be a positive change-request number');
  }
  if (!/^[a-f0-9]{40}$/i.test(head ?? '')) throw new Error('--head must be a full 40-character commit SHA');
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Evidence directory not found: ${dir}`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branchPrefix) || branchPrefix.includes('..')) {
    throw new Error('unsafe evidence branch prefix');
  }

  const root = git(['rev-parse', '--show-toplevel']);
  verifyOrigin(project, root);
  const files = walk(dir).sort();
  if (files.length === 0) throw new Error(`No files in evidence directory: ${dir}`);
  const sides = new Set(files.map((file) => file.split('/')[0]));
  if (!sides.has('before') || !sides.has('after')) {
    throw new Error('Evidence must contain files under both before/ and after/');
  }

  let totalBytes = 0;
  const entries = files.map((relative) => {
    const abs = path.join(dir, ...relative.split('/'));
    const contents = fs.readFileSync(abs);
    assertNoSecrets(relative, contents);
    assertArtifactFormat(relative, contents);
    const bytes = contents.length;
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`${relative} is ${(bytes / 1024 / 1024).toFixed(1)} MB; compress it below 50 MB`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Evidence exceeds the total cap of 100 MB`);
    }
    const safePath = relative.replace(/[^A-Za-z0-9._/-]+/g, '-');
    const target = `issue-${issue}-${safePath.replaceAll('/', '-')}`;
    const sha = git(['hash-object', '-w', '--stdin'], { cwd: root, input: contents });
    return { source: relative, name: target, sha, bytes, kind: kind(relative) };
  });
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw new Error('Evidence file names collide after safe-path normalization');
  }

  const manifest = {
    schema: 1,
    project,
    issue: Number(issue),
    change: Number(change),
    head: head.toLowerCase(),
    files: entries,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha = git(['hash-object', '-w', '--stdin'], { cwd: root, input: manifestBytes });
  const treeEntries = [
    ...entries.map((entry) => `100644 blob ${entry.sha}\t${entry.name}`),
    `100644 blob ${manifestSha}\tmanifest.json`,
  ].sort((a, b) => a.localeCompare(b));
  const tree = git(['mktree'], { cwd: root, input: `${treeEntries.join('\n')}\n` });

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'git-issue-agent',
    GIT_AUTHOR_EMAIL: 'git-issue-agent@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'git-issue-agent',
    GIT_COMMITTER_EMAIL: 'git-issue-agent@users.noreply.github.com',
  };
  const committed = spawnSync(
    'git',
    ['commit-tree', tree, '-m', `Evidence for ${project}#${issue}, PR #${change}, head ${head}`],
    { cwd: root, env, encoding: 'utf8' },
  );
  if (committed.error) throw committed.error;
  if (committed.status !== 0) {
    throw new Error(`git commit-tree failed: ${(committed.stderr || '').trim()}`);
  }
  const commit = (committed.stdout || '').trim();
  const branch = `${branchPrefix}-issue-${issue}-head-${head.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  git(['push', `https://github.com/${project}.git`, `${commit}:refs/heads/${branch}`], { cwd: root });

  return {
    project,
    issue: Number(issue),
    change: Number(change),
    head: head.toLowerCase(),
    branch,
    commit,
    manifest: rawUrl({ project, ref: commit, path: 'manifest.json' }),
    files: entries.map((entry) => ({
      source: entry.source,
      name: entry.name,
      bytes: entry.bytes,
      kind: entry.kind,
      url: rawUrl({ project, ref: commit, path: entry.name }),
    })),
  };
}

export function containsSecretLikeContent(text) {
  const value = Buffer.from(String(text), 'utf8').toString('latin1');
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}
