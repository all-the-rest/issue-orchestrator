import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const BUILDER_IMAGE = 'issue-orchestrator-builder:node24-pnpm11.23.0';

type RuntimeKind = 'docker' | 'podman';

export interface OciSandbox {
  identity: string;
  runtime: string;
  runtimeKind: RuntimeKind;
  imageId: string;
  worktree: string;
  gitCommonDirectory: string;
  gitDirectory: string;
  gitWorktreesDirectory: string;
  gitMarkerFile: string;
  gitPointerFiles: string[];
  gitConfigFiles: string[];
  pnpmStoreDirectory: string;
  uid: number;
  gid: number;
  runtimeEnvironment: NodeJS.ProcessEnv;
}

export interface OciCommandSandbox {
  runtime: string;
  runtimeKind: RuntimeKind;
  imageId: string;
  worktree: string;
  dependencyRoot: string;
  dependencyModules: string;
  uid: number;
  gid: number;
  runtimeEnvironment: NodeJS.ProcessEnv;
}

export interface OciCommandResult {
  error?: Error & { code?: string };
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface OciShellWrapper {
  file: string;
  gitHooksDirectory: string;
}

export class OciSandboxUnavailable extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OciSandboxUnavailable';
  }
}

const COMMAND_TIMEOUT_MS = 10_000;
const DEPENDENCY_PREP_TIMEOUT_MS = 120_000;

function resolveFromPath(command: string, searchPath: string | undefined) {
  if (path.isAbsolute(command)) return command;
  if (command.includes(path.sep)) return path.resolve(command);
  for (const directory of (searchPath ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep searching */ }
  }
  return null;
}

function runtimeEnvironment(source: NodeJS.ProcessEnv, kind: RuntimeKind): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? source.Path ?? process.env.PATH ?? '',
    HOME: source.HOME ?? os.homedir(),
  };
  const allowed = kind === 'docker'
    ? ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']
    : ['CONTAINER_HOST', 'CONTAINER_CONNECTION', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'];
  for (const key of allowed) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  if (kind === 'podman') {
    for (const key of ['TMPDIR', 'TEMP', 'TMP']) {
      if (source[key] !== undefined) environment[key] = source[key];
    }
  }
  return environment;
}

function invoke(runtime: string, args: string[], env: NodeJS.ProcessEnv, purpose: string) {
  const result = spawnSync(runtime, args, {
    encoding: 'utf8',
    env,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new OciSandboxUnavailable(`Could not ${purpose}: ${result.error.message}`, result.error);
  if (result.status !== 0) {
    throw new OciSandboxUnavailable(`Could not ${purpose}: runtime exited ${String(result.status)}${result.signal ? ` (${result.signal})` : ''}`);
  }
  return result.stdout ?? '';
}

function containerUser(runtime: string, kind: RuntimeKind, env: NodeJS.ProcessEnv) {
  let rootless: boolean;
  if (kind === 'docker') {
    const output = invoke(runtime, ['info', '--format={{json .SecurityOptions}}'], env, 'inspect Docker user namespace');
    let options: unknown;
    try { options = JSON.parse(output); }
    catch (error) { throw new OciSandboxUnavailable('Docker returned invalid security options', error); }
    if (!Array.isArray(options) || options.some((option) => typeof option !== 'string')) {
      throw new OciSandboxUnavailable('Docker returned invalid security options');
    }
    rootless = options.some((option: string) => option === 'name=rootless' || option.startsWith('name=rootless,'));
  } else {
    const output = invoke(runtime, ['info', '--format={{.Host.Security.Rootless}}'], env, 'inspect Podman user namespace').trim();
    if (output !== 'true' && output !== 'false') {
      throw new OciSandboxUnavailable('Podman returned an invalid rootless status');
    }
    rootless = output === 'true';
  }
  // In a rootless daemon, namespace uid 0 maps to the unprivileged daemon
  // owner and therefore matches ownership on host bind mounts. Passing the
  // host's numeric uid would map to a subordinate ID and lose write access.
  return rootless ? { uid: 0, gid: 0 } : { uid: process.getuid!(), gid: process.getgid!() };
}

function within(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function ownedDirectory(directory: string, label: string) {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    throw new OciSandboxUnavailable(`${label} is unavailable`, error);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
    throw new OciSandboxUnavailable(`${label} must be an owned, real directory`);
  }
  try {
    return fs.realpathSync(directory);
  } catch (error) {
    throw new OciSandboxUnavailable(`${label} could not be resolved`, error);
  }
}

function gitCommonDirectory(worktree: string) {
  const dotGit = path.join(worktree, '.git');
  let dotGitStat: fs.Stats;
  try { dotGitStat = fs.lstatSync(dotGit); }
  catch (error) { throw new OciSandboxUnavailable('Builder requires a linked Git worktree', error); }
  if (!dotGitStat.isFile() || dotGitStat.isSymbolicLink()) {
    throw new OciSandboxUnavailable('Worktree Git marker must be a regular file');
  }
  const marker = fs.readFileSync(dotGit, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/i.exec(marker);
  if (!match) throw new OciSandboxUnavailable('Builder requires a linked Git worktree');
  const gitDirectory = ownedDirectory(path.resolve(worktree, match[1]), 'Worktree Git metadata');
  const backPointer = path.join(gitDirectory, 'gitdir');
  let backPointerStat: fs.Stats;
  try { backPointerStat = fs.lstatSync(backPointer); }
  catch (error) { throw new OciSandboxUnavailable('Worktree Git back-pointer is unavailable', error); }
  if (!backPointerStat.isFile() || backPointerStat.isSymbolicLink()) {
    throw new OciSandboxUnavailable('Worktree Git back-pointer must be a regular file');
  }
  const backPointerTarget = fs.readFileSync(backPointer, 'utf8').trim();
  if (!backPointerTarget || /[\r\n]/.test(backPointerTarget) ||
      path.resolve(gitDirectory, backPointerTarget) !== dotGit) {
    throw new OciSandboxUnavailable('Worktree Git metadata does not point back to this worktree');
  }
  const commonFile = path.join(gitDirectory, 'commondir');
  let commonStat: fs.Stats;
  try { commonStat = fs.lstatSync(commonFile); }
  catch (error) { throw new OciSandboxUnavailable('Worktree Git common directory is unavailable', error); }
  if (!commonStat.isFile() || commonStat.isSymbolicLink()) {
    throw new OciSandboxUnavailable('Worktree Git common-directory marker must be a regular file');
  }
  const commonMarker = fs.readFileSync(commonFile, 'utf8').trim();
  if (!commonMarker || path.isAbsolute(commonMarker)) {
    throw new OciSandboxUnavailable('Worktree Git common-directory marker is invalid');
  }
  const common = ownedDirectory(path.resolve(gitDirectory, commonMarker), 'Git common directory');
  const relativeGitDirectory = path.relative(common, gitDirectory).split(path.sep);
  if (path.basename(common) !== '.git' || relativeGitDirectory.length !== 2 ||
      relativeGitDirectory[0] !== 'worktrees' || !relativeGitDirectory[1] ||
      !within(common, gitDirectory) || within(worktree, common)) {
    throw new OciSandboxUnavailable('Git common directory is outside the expected linked-worktree layout');
  }
  const worktreesDirectory = ownedDirectory(path.join(common, 'worktrees'), 'Git linked-worktree directory');
  if (worktreesDirectory !== path.join(common, 'worktrees')) {
    throw new OciSandboxUnavailable('Git linked-worktree directory resolves outside the expected metadata layout');
  }
  const configFile = path.join(common, 'config');
  const worktreeConfigFile = path.join(gitDirectory, 'config.worktree');
  const validateConfig = (file: string, label: string, createEmpty = false) => {
    let stats: fs.Stats;
    try { stats = fs.lstatSync(file); }
    catch (error) {
      if (!createEmpty || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new OciSandboxUnavailable(`${label} is unavailable`, error);
      }
      try {
        const fd = fs.openSync(file, 'wx', 0o600);
        fs.closeSync(fd);
        stats = fs.lstatSync(file);
      } catch (createError) {
        throw new OciSandboxUnavailable(`${label} could not be secured`, createError);
      }
    }
    if (!stats.isFile() || stats.isSymbolicLink() ||
        (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
      throw new OciSandboxUnavailable(`${label} must be an owned regular file`);
    }
    const contents = fs.readFileSync(file, 'utf8');
    if (/^[\t ]*extraheader\s*=/im.test(contents) ||
        /\b[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i.test(contents)) {
      throw new OciSandboxUnavailable(`${label} contains embedded remote credentials`);
    }
    return fs.realpathSync(file);
  };
  return {
    common,
    gitDirectory,
    gitWorktreesDirectory: worktreesDirectory,
    gitMarkerFile: fs.realpathSync(dotGit),
    gitPointerFiles: [fs.realpathSync(backPointer), fs.realpathSync(commonFile)],
    // These files can contain executable Git configuration. The OCI wrapper
    // mounts them read-only so an untrusted builder cannot plant a later host
    // command such as core.fsmonitor in shared or per-worktree config.
    gitConfigFiles: [
      validateConfig(configFile, 'Git common configuration'),
      validateConfig(worktreeConfigFile, 'Git worktree configuration', true),
    ],
  };
}

function pnpmEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? source.Path ?? process.env.PATH ?? '',
    HOME: source.HOME ?? os.homedir(),
    npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: '/dev/null',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    NPM_CONFIG_GLOBALCONFIG: '/dev/null',
  };
  for (const key of ['XDG_CONFIG_HOME', 'COREPACK_HOME']) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

function pnpmStoreDirectory(worktree: string, source: NodeJS.ProcessEnv, trustedCwd = process.cwd()) {
  const pnpm = resolveFromPath('pnpm', source.PATH ?? source.Path);
  if (!pnpm) throw new OciSandboxUnavailable('Builder requires pnpm to locate its read-only package store');
  const result = spawnSync(pnpm, ['store', 'path', '--silent'], {
    // Resolve the trusted host store from the runner's own cwd, never from
    // project-controlled .npmrc files in the job worktree.
    cwd: trustedCwd,
    env: pnpmEnvironment(source),
    encoding: 'utf8',
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new OciSandboxUnavailable('Builder could not locate the local pnpm store', result.error);
  }
  const lines = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new OciSandboxUnavailable('pnpm returned an invalid store path');
  const candidate = path.resolve(trustedCwd, lines[0]);
  const store = ownedDirectory(candidate, 'pnpm store');
  if (within(worktree, store) || !/^v\d+$/i.test(path.basename(store)) ||
      !['store', '.pnpm-store'].includes(path.basename(path.dirname(store)))) {
    throw new OciSandboxUnavailable('pnpm store path is not a dedicated versioned store directory');
  }
  return store;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function regularOwnedFile(file: string, label: string) {
  let stats: fs.Stats;
  try { stats = fs.lstatSync(file); }
  catch (error) { throw new OciSandboxUnavailable(`${label} is unavailable`, error); }
  if (!stats.isFile() || stats.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
    throw new OciSandboxUnavailable(`${label} must be an owned regular file`);
  }
  return stats;
}

function dependencySpecs(manifest: Record<string, unknown>) {
  const dependencies = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
  const specs: string[] = [];
  for (const section of dependencies) {
    if (section === undefined) continue;
    if (!isObject(section)) throw new OciSandboxUnavailable('package.json dependency sections must be objects');
    for (const spec of Object.values(section)) {
      if (typeof spec !== 'string') throw new OciSandboxUnavailable('package.json dependency versions must be strings');
      specs.push(spec);
    }
  }
  return specs;
}

function createScopedDependencies(
  worktree: string,
  source: NodeJS.ProcessEnv,
  trustedCwd: string,
): { root: string; modules: string } {
  let runtimeDirectory: string;
  try {
    const stats = fs.lstatSync(trustedCwd);
    if (!stats.isDirectory() || stats.isSymbolicLink() ||
        (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
      throw new Error('not an owned, real runtime directory');
    }
    runtimeDirectory = fs.realpathSync(trustedCwd);
  } catch (error) {
    throw new OciSandboxUnavailable('DoD dependency staging requires a private owned runtime directory', error);
  }

  const manifestPath = path.join(worktree, 'package.json');
  const lockPath = path.join(worktree, 'pnpm-lock.yaml');
  const manifestExists = fs.existsSync(manifestPath);
  const lockExists = fs.existsSync(lockPath);
  let manifest: Record<string, unknown> | null = null;
  if (manifestExists) {
    const stats = regularOwnedFile(manifestPath, 'DoD package manifest');
    if (stats.size > 1024 * 1024) throw new OciSandboxUnavailable('DoD package manifest exceeds the safe staging limit');
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!isObject(parsed)) throw new Error('manifest is not an object');
      manifest = parsed;
    } catch (error) {
      throw new OciSandboxUnavailable('DoD package manifest is invalid JSON', error);
    }
  }
  if (lockExists) {
    const stats = regularOwnedFile(lockPath, 'DoD pnpm lockfile');
    if (stats.size > 8 * 1024 * 1024) throw new OciSandboxUnavailable('DoD pnpm lockfile exceeds the safe staging limit');
  }
  const specs = manifest ? dependencySpecs(manifest) : [];
  const hasDependencies = specs.length > 0;
  if (hasDependencies && !lockExists) {
    throw new OciSandboxUnavailable('DoD dependencies require a pnpm lockfile; refusing an unpinned dependency install');
  }
  if (lockExists && !manifest) throw new OciSandboxUnavailable('DoD pnpm lockfile has no package manifest');
  if (specs.some((spec) => /^(?:file:|link:|workspace:|catalog:)/i.test(spec))) {
    throw new OciSandboxUnavailable('DoD scoped dependency staging does not permit local or workspace dependency links');
  }
  if (manifest && (manifest.workspaces !== undefined || fs.existsSync(path.join(worktree, 'pnpm-workspace.yaml')))) {
    throw new OciSandboxUnavailable('DoD scoped dependency staging does not permit workspace dependencies');
  }
  const pnpmConfig = manifest && isObject(manifest.pnpm) ? manifest.pnpm : {};
  if (Object.keys(pnpmConfig).some((key) => key === 'patchedDependencies')) {
    throw new OciSandboxUnavailable('DoD scoped dependency staging does not permit workspace patch files');
  }

  let root: string;
  try {
    root = fs.mkdtempSync(path.join(runtimeDirectory, 'dod-dependencies-'));
    fs.chmodSync(root, 0o700);
  } catch (error) {
    throw new OciSandboxUnavailable('Could not create private DoD dependency staging directory', error);
  }
  const modules = path.join(root, 'node_modules');
  try {
    if (manifest && lockExists) {
      regularOwnedFile(lockPath, 'DoD pnpm lockfile');
      const store = pnpmStoreDirectory(worktree, source, runtimeDirectory);
      const pnpm = resolveFromPath('pnpm', source.PATH ?? source.Path);
      if (!pnpm) throw new OciSandboxUnavailable('pnpm is unavailable for scoped DoD dependency staging');
      const stagedManifest = path.join(root, 'package.json');
      const stagedLock = path.join(root, 'pnpm-lock.yaml');
      const installManifest = { ...manifest };
      // Do not let a packageManager pin launch a different package-manager
      // binary while preparing the offline tree; this exact trusted executable
      // is already selected by resolveFromPath above.
      delete installManifest.packageManager;
      fs.writeFileSync(stagedManifest, JSON.stringify(installManifest, null, 2), { flag: 'wx', mode: 0o600 });
      fs.copyFileSync(lockPath, stagedLock, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(stagedLock, 0o600);
      const isolatedHome = path.join(root, 'home');
      const isolatedConfig = path.join(root, 'config');
      const isolatedCache = path.join(root, 'cache');
      fs.mkdirSync(isolatedHome, { mode: 0o700 });
      fs.mkdirSync(isolatedConfig, { mode: 0o700 });
      fs.mkdirSync(isolatedCache, { mode: 0o700 });
      fs.chmodSync(isolatedCache, 0o700);
      const installEnvironment: NodeJS.ProcessEnv = {
        PATH: source.PATH ?? source.Path ?? process.env.PATH ?? '',
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_CACHE_HOME: isolatedCache,
        npm_config_userconfig: '/dev/null',
        npm_config_globalconfig: '/dev/null',
        NPM_CONFIG_USERCONFIG: '/dev/null',
        NPM_CONFIG_GLOBALCONFIG: '/dev/null',
        NODE_ENV: 'development',
        COREPACK_ENABLE_NETWORK: '0',
      };
      const installed = spawnSync(pnpm, [
        'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile',
        '--prod=false', '--package-import-method=copy', `--store-dir=${store}`,
      ], {
        cwd: root,
        env: installEnvironment,
        shell: false,
        encoding: 'buffer',
        timeout: DEPENDENCY_PREP_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      if (installed.error || installed.status !== 0) {
        throw new OciSandboxUnavailable('Could not prepare locked DoD dependencies offline without lifecycle scripts', installed.error);
      }
    } else {
      fs.mkdirSync(modules, { mode: 0o700 });
    }
    const moduleStats = fs.lstatSync(modules);
    if (!moduleStats.isDirectory() || moduleStats.isSymbolicLink() ||
        (typeof process.getuid === 'function' && moduleStats.uid !== process.getuid())) {
      throw new Error('scoped node_modules is not an owned real directory');
    }
    const moduleRealPath = fs.realpathSync(modules);
    if (!within(root, moduleRealPath)) throw new Error('scoped node_modules escaped its private staging directory');
    assertScopedLinks(moduleRealPath, root);
    return { root, modules: moduleRealPath };
  } catch (error) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* preserve the setup failure */ }
    if (error instanceof OciSandboxUnavailable) throw error;
    throw new OciSandboxUnavailable('Could not prepare an isolated DoD dependency tree', error);
  }
}

function assertScopedLinks(root: string, scopeRoot: string) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try { target = fs.realpathSync(file); }
        catch (error) { throw new OciSandboxUnavailable('Scoped DoD dependency contains a broken symlink', error); }
        if (!within(scopeRoot, target)) throw new OciSandboxUnavailable('Scoped DoD dependency symlink escapes its private directory');
      } else if (entry.isDirectory()) pending.push(file);
    }
  }
}

function removeScopedDependencies(sandbox: OciCommandSandbox) {
  try {
    const stats = fs.lstatSync(sandbox.dependencyRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink() ||
        (typeof process.getuid === 'function' && stats.uid !== process.getuid()) ||
        path.basename(sandbox.dependencyRoot).startsWith('dod-dependencies-') === false) {
      throw new Error('dependency staging path is not an owned private directory');
    }
    const root = fs.realpathSync(sandbox.dependencyRoot);
    if (root !== sandbox.dependencyRoot || path.resolve(sandbox.dependencyModules) !== path.join(root, 'node_modules')) {
      throw new Error('dependency staging paths changed during DoD execution');
    }
    fs.rmSync(root, { recursive: true, force: false });
  } catch (error) {
    throw new OciSandboxUnavailable('Could not remove private DoD dependency staging directory', error);
  }
}

function assertMountSafe(source: string, name: string) {
  if (source.includes(',') || source.includes('\n') || source.includes('\r')) {
    throw new OciSandboxUnavailable(`${name} contains characters unsupported by safe OCI bind mounts`);
  }
}

function candidateRuntimes(runtimeOverride: string | undefined, source: NodeJS.ProcessEnv) {
  const searchPath = source.PATH ?? source.Path;
  if (runtimeOverride) {
    const executable = resolveFromPath(runtimeOverride, searchPath) ?? runtimeOverride;
    const kind: RuntimeKind = /podman/i.test(path.basename(executable)) ? 'podman' : 'docker';
    return [{ executable, kind }];
  }
  const candidates: Array<{ executable: string; kind: RuntimeKind }> = [];
  for (const [command, kind] of [['docker', 'docker'], ['podman', 'podman']] as const) {
    const executable = resolveFromPath(command, searchPath);
    if (executable) candidates.push({ executable, kind });
  }
  return candidates;
}

function hashDirectoryContents(root: string) {
  let rootStats: fs.Stats;
  try { rootStats = fs.lstatSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new OciSandboxUnavailable('OCI runtime context metadata is not a real directory');
  }
  const hash = createHash('sha256');
  const pending = [root];
  let files = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new OciSandboxUnavailable('OCI runtime context metadata contains a symlink');
      }
      if (entry.isDirectory()) {
        pending.push(file);
      } else if (entry.isFile()) {
        hash.update(path.relative(root, file));
        hash.update('\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
        files += 1;
      } else {
        throw new OciSandboxUnavailable('OCI runtime context metadata contains a non-regular file');
      }
    }
  }
  return files > 0 ? hash.digest('hex') : null;
}

export function prepareOciSandbox(
  worktreeInput: string,
  runtimeOverride: string | undefined,
  source: NodeJS.ProcessEnv,
): OciSandbox {
  if (!['linux', 'darwin'].includes(process.platform) ||
      typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new OciSandboxUnavailable('Builder OCI execution requires Linux or macOS with numeric user IDs');
  }
  const worktree = fs.realpathSync(worktreeInput);
  if (/[\\*?\n\r]/.test(worktree)) {
    throw new OciSandboxUnavailable('Builder worktree path contains characters unsafe for permission or mount rules');
  }
  const {
    common, gitDirectory, gitWorktreesDirectory, gitMarkerFile, gitPointerFiles, gitConfigFiles,
  } = gitCommonDirectory(worktree);
  const store = pnpmStoreDirectory(worktree, source);
  assertMountSafe(worktree, 'Worktree path');
  assertMountSafe(common, 'Git common-directory path');
  assertMountSafe(gitDirectory, 'Worktree Git metadata path');
  assertMountSafe(gitWorktreesDirectory, 'Git linked-worktree directory path');
  for (const file of [...gitPointerFiles, gitMarkerFile, ...gitConfigFiles]) {
    assertMountSafe(file, 'Git metadata file path');
  }
  assertMountSafe(store, 'pnpm store path');
  const candidates = candidateRuntimes(runtimeOverride, source);
  if (candidates.length === 0) throw new OciSandboxUnavailable('Builder requires an installed Docker or Podman runtime');
  let lastError: unknown;
  for (const candidate of candidates) {
    const env = runtimeEnvironment(source, candidate.kind);
    try {
      const output = invoke(candidate.executable,
        ['image', 'inspect', '--format={{.Id}}', BUILDER_IMAGE], env, 'inspect the preloaded builder image');
      const match = /(?:sha256:)?([a-f0-9]{64})/i.exec(output.trim());
      if (!match) throw new OciSandboxUnavailable('Builder image inspection returned an invalid image ID');
      const user = containerUser(candidate.executable, candidate.kind, env);
      const selectors = candidate.kind === 'docker'
        ? ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']
        : ['CONTAINER_HOST', 'CONTAINER_CONNECTION', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'];
      const selectorIdentity = Object.fromEntries(selectors
        .filter((key) => env[key] !== undefined)
        .sort()
        .map((key) => [key, createHash('sha256').update(env[key]!).digest('hex')]));
      selectorIdentity.home = createHash('sha256').update(env.HOME ?? os.homedir()).digest('hex');
      if (candidate.kind === 'docker') {
        const configDirectory = env.DOCKER_CONFIG ?? path.join(env.HOME ?? os.homedir(), '.docker');
        const configFile = path.join(configDirectory, 'config.json');
        try {
          // Hash rather than persist Docker config: it can contain auth material,
          // while its currentContext selection must participate in identity.
          selectorIdentity.dockerConfig = createHash('sha256').update(fs.readFileSync(configFile)).digest('hex');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // Docker stores endpoint metadata outside config.json under contexts/meta.
        // Hash the metadata tree too so a changed endpoint behind the same context
        // name cannot make stale recovery target a different engine.
        selectorIdentity.dockerContexts = hashDirectoryContents(path.join(configDirectory, 'contexts', 'meta')) ?? '';
      } else {
        const connectionFile = path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? os.homedir(), '.config'), 'containers', 'podman-connections.json');
        try {
          selectorIdentity.podmanConnections = createHash('sha256').update(fs.readFileSync(connectionFile)).digest('hex');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const identity = createHash('sha256')
        .update(JSON.stringify({ executable: candidate.executable, kind: candidate.kind, selectors: selectorIdentity }))
        .digest('hex');
      return {
        identity,
        runtime: candidate.executable,
        runtimeKind: candidate.kind,
        imageId: `sha256:${match[1].toLowerCase()}`,
        worktree,
        gitCommonDirectory: common,
        gitDirectory,
        gitWorktreesDirectory,
        gitMarkerFile,
        gitPointerFiles,
        gitConfigFiles,
        pnpmStoreDirectory: store,
        uid: user.uid,
        gid: user.gid,
        runtimeEnvironment: env,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new OciSandboxUnavailable(
    `Builder requires the preloaded ${BUILDER_IMAGE} image in Docker or Podman; the runner will not pull images`,
    lastError,
  );
}

export function prepareOciCommandSandbox(
  worktreeInput: string,
  runtimeOverride: string | undefined,
  source: NodeJS.ProcessEnv,
  trustedCwd: string,
): OciCommandSandbox {
  if (!['linux', 'darwin'].includes(process.platform) ||
      typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new OciSandboxUnavailable('DoD OCI execution requires Linux or macOS with numeric user IDs');
  }
  let worktree: string;
  try {
    const stats = fs.lstatSync(worktreeInput);
    if (!stats.isDirectory() || stats.isSymbolicLink() ||
        (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
      throw new Error('not an owned, real worktree directory');
    }
    worktree = fs.realpathSync(worktreeInput);
  } catch (error) {
    throw new OciSandboxUnavailable('DoD worktree is unavailable or unsafe', error);
  }
  if (/[\\*?\n\r]/.test(worktree)) {
    throw new OciSandboxUnavailable('DoD worktree path contains characters unsafe for OCI mounts');
  }
  assertMountSafe(worktree, 'DoD worktree path');
  assertMountSafe(trustedCwd, 'DoD dependency parent path');
  const candidates = candidateRuntimes(runtimeOverride, source);
  if (candidates.length === 0) throw new OciSandboxUnavailable('DoD requires an installed Docker or Podman runtime');
  let lastError: unknown;
  let selected: {
    executable: string;
    kind: RuntimeKind;
    env: NodeJS.ProcessEnv;
    imageId: string;
    user: { uid: number; gid: number };
  } | undefined;
  for (const candidate of candidates) {
    const env = runtimeEnvironment(source, candidate.kind);
    try {
      const output = invoke(candidate.executable,
        ['image', 'inspect', '--format={{.Id}}', BUILDER_IMAGE], env, 'inspect the preloaded DoD image');
      const match = /(?:sha256:)?([a-f0-9]{64})/i.exec(output.trim());
      if (!match) throw new OciSandboxUnavailable('DoD image inspection returned an invalid image ID');
      const user = containerUser(candidate.executable, candidate.kind, env);
      selected = {
        executable: candidate.executable,
        kind: candidate.kind,
        env,
        imageId: `sha256:${match[1].toLowerCase()}`,
        user,
      };
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!selected) {
    throw new OciSandboxUnavailable(
      `DoD requires the preloaded ${BUILDER_IMAGE} image in Docker or Podman; the runner will not pull images`,
      lastError,
    );
  }
  const dependencies = createScopedDependencies(worktree, source, trustedCwd);
  assertMountSafe(dependencies.modules, 'scoped DoD dependency path');
  return {
    runtime: selected.executable,
    runtimeKind: selected.kind,
    imageId: selected.imageId,
    worktree,
    dependencyRoot: dependencies.root,
    dependencyModules: dependencies.modules,
    uid: selected.user.uid,
    gid: selected.user.gid,
    runtimeEnvironment: selected.env,
  };
}

export function cleanupOciCommandSandbox(sandbox: OciCommandSandbox) {
  removeScopedDependencies(sandbox);
}

export function runOciCommand(
  sandbox: OciCommandSandbox,
  sessionId: string,
  executionId: string,
  category: string,
  argv: string[],
  timeoutMs: number,
  maxBufferBytes: number,
): OciCommandResult {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId) || !/^[A-Za-z0-9_-]+$/.test(executionId)) {
    throw new OciSandboxUnavailable('Invalid DoD OCI execution label');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(category)) throw new OciSandboxUnavailable('Invalid DoD category label');
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string' || part.includes('\0'))) {
    throw new OciSandboxUnavailable('DoD command argv is invalid');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
    throw new OciSandboxUnavailable('DoD command timeout or output limit is invalid');
  }
  // A prior orchestrator crash may have left a command container running with
  // an older, non-persisted execution ID. There is one guarded run per job, so
  // clear every command container for this job before starting the next gate.
  cleanupOciContainers(sandbox, sessionId);
  const mount = (source: string, target: string, readonly = false) =>
    'type=bind,source=' + source + ',target=' + target + (readonly ? ',readonly' : '');
  const args = [
    'run', '--rm', '--pull=never',
    '--label=issue-orchestrator.managed=true',
    '--label=issue-orchestrator.session=' + sessionId,
    '--label=issue-orchestrator.execution=' + executionId,
    '--label=issue-orchestrator.dod.category=' + category,
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--pids-limit=256',
    '--memory=4g', '--cpus=2', '--ulimit=nofile=1024:1024', '--ulimit=core=0',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=1g', '--workdir=/workspace',
    '--user=' + sandbox.uid + ':' + sandbox.gid,
    '--mount=' + mount(sandbox.worktree, '/workspace'),
    '--mount=' + mount(sandbox.dependencyModules, '/workspace/node_modules', true),
    '--env=HOME=/tmp/home', '--env=TMPDIR=/tmp',
    '--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--env=XDG_CONFIG_HOME=/tmp/home/.config', '--env=XDG_CACHE_HOME=/tmp/home/.cache',
    '--env=COREPACK_HOME=/opt/corepack', '--env=COREPACK_ENABLE_NETWORK=0',
    '--env=PNPM_HOME=/tmp/pnpm-home', '--env=PNPM_CONFIG_STORE_DIR=/tmp/pnpm-store',
    '--env=npm_config_userconfig=/dev/null', '--env=npm_config_globalconfig=/dev/null',
    '--env=GIT_CONFIG_NOSYSTEM=1', '--env=GIT_CONFIG_GLOBAL=/dev/null',
    '--env=GIT_TERMINAL_PROMPT=0',
    '--entrypoint', argv[0], sandbox.imageId, ...argv.slice(1),
  ];
  try {
    const result = spawnSync(sandbox.runtime, args, {
      encoding: 'buffer',
      env: sandbox.runtimeEnvironment,
      shell: false,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: maxBufferBytes,
      windowsHide: true,
    });
    return {
      error: result.error,
      status: result.status,
      signal: result.signal,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
    };
  } finally {
    cleanupOciContainers(sandbox, sessionId, executionId);
  }
}

function wrapperSource(sandbox: OciSandbox, sessionId: string, executionId: string, gitHooksDirectory: string) {
  const policy = JSON.stringify({
    runtime: sandbox.runtime,
    runtimeKind: sandbox.runtimeKind,
    imageId: sandbox.imageId,
    worktree: sandbox.worktree,
    gitCommonDirectory: sandbox.gitCommonDirectory,
    gitDirectory: sandbox.gitDirectory,
    gitWorktreesDirectory: sandbox.gitWorktreesDirectory,
    gitMarkerFile: sandbox.gitMarkerFile,
    gitPointerFiles: sandbox.gitPointerFiles,
    gitConfigFiles: sandbox.gitConfigFiles,
    pnpmStoreDirectory: sandbox.pnpmStoreDirectory,
    uid: sandbox.uid,
    gid: sandbox.gid,
    sessionId,
    executionId,
    gitHooksDirectory,
    runtimeEnvironment: sandbox.runtimeEnvironment,
  });
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const policy = ${policy};
let command;
try {
  const args = process.argv.slice(2);
  if (args.length === 3 && args[0] === '-l' && args[1] === '-c') command = args[2];
  else if (args.length === 2 && args[0] === '-c') command = args[1];
  else if (args.length === 2 && (args[0] === '-lc' || args[0] === '-cl')) command = args[1];
  else throw new Error('unsupported shell invocation');
} catch (error) {
  process.stderr.write('OCI shell wrapper rejected invocation: ' + error.message + '\\n');
  process.exit(126);
}
const mount = (source, target, readonly = false) =>
  'type=bind,source=' + source + ',target=' + target + (readonly ? ',readonly' : '');
const args = [
  'run', '--rm', '--pull=never',
  '--label=issue-orchestrator.managed=true',
  '--label=issue-orchestrator.session=' + policy.sessionId,
  '--label=issue-orchestrator.execution=' + policy.executionId,
  '--network=none', '--read-only', '--cap-drop=ALL',
  '--security-opt=no-new-privileges:true', '--pids-limit=256',
  '--memory=4g', '--cpus=2', '--ulimit=nofile=1024:1024', '--ulimit=core=0',
  '--tmpfs=/tmp:rw,nosuid,nodev,size=1g', '--workdir=/workspace',
  '--user=' + policy.uid + ':' + policy.gid,
  '--mount=' + mount(policy.worktree, '/workspace'),
  '--mount=' + mount(policy.gitCommonDirectory, policy.gitCommonDirectory),
  '--mount=' + mount(policy.gitHooksDirectory, policy.gitCommonDirectory + '/hooks', true),
  // Lock the worktree marker and linked-worktree directory so the builder
  // cannot redirect host Git by replacing .git, commondir, or its gitdir.
  '--mount=' + mount(policy.gitMarkerFile, '/workspace/.git', true),
  '--mount=' + mount(policy.gitWorktreesDirectory, policy.gitWorktreesDirectory, true),
  // Git still needs to update HEAD, index, and its lock files for local commits.
  '--mount=' + mount(policy.gitDirectory, policy.gitDirectory),
  ...policy.gitPointerFiles.map((file) => '--mount=' + mount(file, file, true)),
  ...policy.gitConfigFiles.map((file) => '--mount=' + mount(file, file, true)),
   '--mount=' + mount(policy.pnpmStoreDirectory, '/pnpm-store/v11', true),
   '--env=HOME=/tmp/home', '--env=TMPDIR=/tmp',
   '--env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
   '--env=XDG_CONFIG_HOME=/tmp/home/.config', '--env=XDG_CACHE_HOME=/tmp/home/.cache',
   '--env=COREPACK_HOME=/opt/corepack', '--env=COREPACK_ENABLE_NETWORK=0',
   '--env=PNPM_HOME=/tmp/pnpm-home', '--env=PNPM_CONFIG_STORE_DIR=/pnpm-store/v11',
   '--env=GIT_CONFIG_COUNT=1', '--env=GIT_CONFIG_KEY_0=core.hooksPath', '--env=GIT_CONFIG_VALUE_0=/dev/null',
   '--env=GIT_CONFIG_NOSYSTEM=1', '--env=GIT_CONFIG_GLOBAL=/dev/null',
  '--env=GIT_TERMINAL_PROMPT=0', '--env=GIT_AUTHOR_NAME=Issue Orchestrator Builder',
  '--env=GIT_AUTHOR_EMAIL=issue-orchestrator@localhost',
  '--env=GIT_COMMITTER_NAME=Issue Orchestrator Builder',
  '--env=GIT_COMMITTER_EMAIL=issue-orchestrator@localhost',
  '--entrypoint=/bin/sh', policy.imageId, '-lc', command,
];
const result = spawnSync(policy.runtime, args, {
  env: { ...policy.runtimeEnvironment, ISSUE_ORCHESTRATOR_EXECUTION_ID: policy.executionId },
  shell: false, stdio: 'inherit', windowsHide: true,
});
if (result.error) {
  process.stderr.write('OCI command failed to start: ' + result.error.message + '\\n');
  process.exit(127);
}
if (result.signal) process.exit(128);
process.exit(result.status ?? 1);
`;
}

export function writeOciShellWrapper(sandbox: OciSandbox, sessionId: string, executionId: string, file: string) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) throw new OciSandboxUnavailable('Invalid session label for OCI cleanup');
  if (!/^[A-Za-z0-9_-]+$/.test(executionId)) throw new OciSandboxUnavailable('Invalid execution label for OCI cleanup');
  // OCI daemons used in CI may see the checked-out project/store roots but not
  // /tmp or the runtime home. Put this private source beside the Git common dir,
  // outside both mounted paths, so the daemon can bind it without exposing it
  // to the builder through the common-directory mount.
  const gitHooksDirectory = fs.mkdtempSync(
    path.join(path.dirname(sandbox.gitCommonDirectory), '.issue-orchestrator-hooks-mask-'),
  );
  try {
    fs.chmodSync(gitHooksDirectory, 0o500);
    const hooksStat = fs.lstatSync(gitHooksDirectory);
    if (!hooksStat.isDirectory() || hooksStat.isSymbolicLink() ||
        (typeof process.getuid === 'function' && hooksStat.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (hooksStat.mode & 0o077) !== 0) ||
        fs.readdirSync(gitHooksDirectory).length !== 0) {
      throw new Error('private hooks mask is not an owned, empty directory');
    }
    fs.writeFileSync(file, wrapperSource(sandbox, sessionId, executionId, gitHooksDirectory), { mode: 0o700, flag: 'wx' });
    fs.chmodSync(file, 0o700);
    const stats = fs.lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
      throw new Error('generated shell wrapper is not private and executable');
    }
  } catch (error) {
    try { fs.unlinkSync(file); } catch { /* preserve the setup failure */ }
    try { fs.chmodSync(gitHooksDirectory, 0o700); fs.rmSync(gitHooksDirectory, { recursive: true, force: true }); }
    catch { /* preserve the setup failure */ }
    throw new OciSandboxUnavailable('Could not secure generated OCI shell wrapper', error);
  }
  return { file, gitHooksDirectory } satisfies OciShellWrapper;
}

export function cleanupOciContainers(
  sandbox: Pick<OciSandbox, 'runtime' | 'runtimeEnvironment'>,
  sessionId: string,
  executionId?: string,
) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) throw new OciSandboxUnavailable('Invalid session label for OCI cleanup');
  if (executionId !== undefined && !/^[A-Za-z0-9_-]+$/.test(executionId)) {
    throw new OciSandboxUnavailable('Invalid execution label for OCI cleanup');
  }
  const filters = [`label=issue-orchestrator.session=${sessionId}`];
  if (executionId) filters.push(`label=issue-orchestrator.execution=${executionId}`);
  const output = invoke(sandbox.runtime,
    ['container', 'ls', '--all', '--quiet', ...filters.map((filter) => `--filter=${filter}`)],
    sandbox.runtimeEnvironment, 'list builder containers');
  const ids = output.trim().split(/\r?\n/).filter(Boolean);
  if (ids.length === 0) return;
  if (ids.some((id) => !/^[a-f0-9]{12,64}$/i.test(id))) {
    throw new OciSandboxUnavailable('OCI runtime returned an invalid container ID during cleanup');
  }
  invoke(sandbox.runtime, ['container', 'rm', '--force', ...ids], sandbox.runtimeEnvironment, 'remove builder containers');
}
