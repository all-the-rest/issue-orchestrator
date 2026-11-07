import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { git, verifyOrigin } from '../git/index.js';

export { verifyOrigin };

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

export function validateEvidenceDirectory(dir, issue) {
  if (!Number.isSafeInteger(Number(issue)) || Number(issue) <= 0) throw new Error('issue must be a positive number');
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Evidence directory not found: ${dir}`);
  }
  const files = walk(dir).sort();
  if (files.length === 0) throw new Error(`No files in evidence directory: ${dir}`);
  const sides = new Set(files.map((file) => file.split('/')[0]));
  if (!sides.has('before') || !sides.has('after')) {
    throw new Error('Evidence must contain files under both before/ and after/');
  }
  let totalBytes = 0;
  const targets = new Set();
  for (const relative of files) {
    const contents = fs.readFileSync(path.join(dir, ...relative.split('/')));
    assertNoSecrets(relative, contents);
    assertArtifactFormat(relative, contents);
    if (contents.length > MAX_FILE_BYTES) {
      throw new Error(`${relative} is ${(contents.length / 1024 / 1024).toFixed(1)} MB; compress it below 50 MB`);
    }
    totalBytes += contents.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Evidence exceeds the total cap of 100 MB');
    targets.add(`issue-${issue}-${relative.replace(/[^A-Za-z0-9._/-]+/g, '-').replaceAll('/', '-')}`);
  }
  if (targets.size !== files.length) throw new Error('Evidence file names collide after safe-path normalization');
}

export function reconcileEvidenceBranch({ project, issue, change, head, branch, expectedManifest, rawUrl }) {
  const root = git(['rev-parse', '--show-toplevel']);
  verifyOrigin(project, root);
  const url = `https://github.com/${project}.git`;
  const ref = `refs/heads/${branch}`;
  const advertised = git(['ls-remote', '--heads', url, ref], { cwd: root });
  if (!advertised) return null;
  const remoteSha = advertised.split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/i.test(remoteSha)) throw new Error('remote evidence branch returned an invalid commit SHA');
  git(['fetch', '--no-tags', url, ref], { cwd: root });
  const fetchedSha = git(['rev-parse', 'FETCH_HEAD'], { cwd: root });
  if (fetchedSha !== remoteSha) throw new Error('remote evidence branch changed during reconciliation');

  let manifestText;
  let manifest;
  try {
    manifestText = git(['show', `${remoteSha}:manifest.json`], { cwd: root });
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`existing evidence branch has no valid manifest: ${(error as Error).message}`);
  }
  if (manifest.schema !== 1 || manifest.project !== project || Number(manifest.issue) !== Number(issue) ||
      Number(manifest.change) !== Number(change) || manifest.head !== head.toLowerCase() ||
      !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('existing evidence branch manifest does not match this job; refusing to publish a duplicate');
  }
  if (!expectedManifest || !isDeepStrictEqual(manifest, expectedManifest)) {
    throw new Error('existing evidence branch does not match the locally expected manifest and artifact hashes');
  }

  const treeOutput = git(['ls-tree', '-r', '-z', remoteSha], { cwd: root });
  const tree = new Map();
  if (!treeOutput.endsWith('\0')) throw new Error('evidence branch tree has malformed NUL-delimited records');
  const records = treeOutput.slice(0, -1).split('\0');
  if (records.length === 0 || records.some((record) => !record)) {
    throw new Error('evidence branch tree has an empty or malformed record');
  }
  for (const record of records) {
    const separator = record.indexOf('\t');
    if (separator <= 0 || separator === record.length - 1) {
      throw new Error('evidence branch tree contains a malformed entry');
    }
    const metadata = record.slice(0, separator).match(/^(\d{6}) (blob) ([a-f0-9]{40})$/i);
    const filePath = record.slice(separator + 1);
    if (!metadata || metadata[1] !== '100644' || tree.has(filePath)) {
      throw new Error('evidence branch tree contains an unsupported or duplicate entry');
    }
    tree.set(filePath, { mode: metadata[1], sha: metadata[3] });
  }
  const expectedPaths = new Set(['manifest.json']);
  for (const file of manifest.files) {
    if (!file || typeof file.name !== 'string' || !file.name || expectedPaths.has(file.name)) {
      throw new Error('evidence branch manifest has an invalid or duplicate artifact path');
    }
    expectedPaths.add(file.name);
  }
  if (tree.size !== expectedPaths.size || [...tree.keys()].some((filePath) => !expectedPaths.has(filePath))) {
    throw new Error('evidence branch tree path set does not exactly match its manifest');
  }
  const manifestEntry = tree.get('manifest.json');
  const canonicalManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!manifestEntry || manifestEntry.mode !== '100644' ||
      git(['hash-object', '--stdin'], { cwd: root, input: canonicalManifest }) !== manifestEntry.sha ||
      tree.size !== manifest.files.length + 1) {
    throw new Error('evidence branch manifest or tree is inconsistent');
  }
  const sides = new Set();
  const names = new Set();
  for (const file of manifest.files) {
    const sourceParts = typeof file.source === 'string' ? file.source.split('/') : [];
    if (sourceParts.length < 2 || !['before', 'after'].includes(sourceParts[0]) ||
        sourceParts.some((part) => !part || part === '.' || part === '..') ||
        typeof file.name !== 'string' || file.name !== `issue-${issue}-${file.source.replace(/[^A-Za-z0-9._/-]+/g, '-').replaceAll('/', '-')}` ||
        names.has(file.name)) {
      throw new Error('evidence branch contains an unsafe or duplicate manifest path');
    }
    const entry = tree.get(file.name);
    if (!entry || entry.mode !== '100644' || entry.sha !== file.sha ||
        !Number.isSafeInteger(file.bytes) || file.bytes <= 0 ||
        Number(git(['cat-file', '-s', entry.sha], { cwd: root })) !== file.bytes ||
        !/^[a-f0-9]{40}$/i.test(file.sha ?? '')) {
      throw new Error(`evidence branch artifact does not match its manifest: ${file.name}`);
    }
    names.add(file.name);
    if (typeof file.source === 'string') sides.add(file.source.split('/')[0]);
  }
  if (!sides.has('before') || !sides.has('after')) throw new Error('evidence branch must contain before/ and after/ artifacts');
  return {
    project,
    issue: Number(issue),
    change: Number(change),
    head: head.toLowerCase(),
    branch,
    commit: remoteSha,
    manifest: rawUrl({ project, ref: remoteSha, path: 'manifest.json' }),
    files: manifest.files.map((file) => ({
      source: file.source,
      name: file.name,
      bytes: file.bytes,
      kind: file.kind,
      url: rawUrl({ project, ref: remoteSha, path: file.name }),
    })),
  };
}

/**
 * Publish immutable, SHA-pinned evidence linked to one issue, PR and source
 * head. The configured GitHub project is checked against origin; the push URL
 * itself is canonical and never inferred from an arbitrary remote.
 */
export function prepareEvidenceManifest({ project, issue, change, head, dir }) {
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

  const root = git(['rev-parse', '--show-toplevel']);
  verifyOrigin(project, root);
  validateEvidenceDirectory(dir, Number(issue));
  const files = walk(dir).sort();
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
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Evidence exceeds the total cap of 100 MB');
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
  return { root, entries, manifest };
}

export function publishEvidence({
  project,
  issue,
  change,
  head,
  dir,
  branchPrefix = 'agent-evidence',
  branch,
  preparedEvidence,
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
  const expectedPrefix = `${branchPrefix}-issue-${issue}-head-${head.slice(0, 12)}-`;
  if (typeof branch !== 'string' || !branch.startsWith(expectedPrefix) ||
      !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) {
    throw new Error('evidence branch is not bound to the configured job identity');
  }
  const prepared = preparedEvidence ?? prepareEvidenceManifest({ project, issue, change, head, dir });
  const { root, entries, manifest } = prepared;
  if (manifest.project !== project || Number(manifest.issue) !== Number(issue) ||
      Number(manifest.change) !== Number(change) || manifest.head !== head.toLowerCase()) {
    throw new Error('prepared evidence manifest does not match this job');
  }
  verifyOrigin(project, root);
  const reconciled = reconcileEvidenceBranch({ project, issue, change, head, branch, expectedManifest: manifest, rawUrl });
  if (reconciled) return reconciled;
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
  const commit = git(
    ['commit-tree', tree, '-m', `Evidence for ${project}#${issue}, PR #${change}, head ${head}`],
    { cwd: root, env },
  );
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
