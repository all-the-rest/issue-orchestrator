import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { databasePath } from '../core/persistence.js';

function trustedEmptyHooksDirectory() {
  const runtimeDirectory = path.dirname(databasePath());
  fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  let runtimeStat = fs.lstatSync(runtimeDirectory);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && runtimeStat.uid !== process.getuid())) {
    throw new Error('Git safety directory must be an owned, real runtime directory');
  }
  fs.chmodSync(runtimeDirectory, 0o700);
  runtimeStat = fs.lstatSync(runtimeDirectory);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() ||
      (process.platform !== 'win32' && (runtimeStat.mode & 0o077) !== 0)) {
    throw new Error('Git safety runtime directory is not private');
  }

  const hooksDirectory = path.join(fs.realpathSync(runtimeDirectory), 'empty-git-hooks');
  fs.mkdirSync(hooksDirectory, { recursive: true, mode: 0o700 });
  const hooksStat = fs.lstatSync(hooksDirectory);
  if (!hooksStat.isDirectory() || hooksStat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && hooksStat.uid !== process.getuid())) {
    throw new Error('Git hooks override must be an owned, real directory');
  }
  fs.chmodSync(hooksDirectory, 0o700);
  const privateHooksStat = fs.lstatSync(hooksDirectory);
  if (!privateHooksStat.isDirectory() || privateHooksStat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && privateHooksStat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (privateHooksStat.mode & 0o077) !== 0)) {
    throw new Error('Git hooks override directory is not private');
  }
  if (fs.readdirSync(hooksDirectory).length !== 0) {
    throw new Error('Git hooks override directory must remain empty');
  }
  return fs.realpathSync(hooksDirectory);
}

export function git(
  args: string[],
  { cwd, input, env, allowExitCodes = [] as number[] }: {
    cwd?: string;
    input?: string | Buffer;
    env?: Record<string, string>;
    allowExitCodes?: number[];
  } = {},
) {
  if (args.some((argument) => /^-c(?:$|.+)|^--config-env(?:=|$)/.test(argument))) {
    throw new Error('git helper does not permit caller-supplied command-scope configuration');
  }
  const safeEnvironment = env ? { ...process.env, ...env } : { ...process.env };
  // These environment config channels have command-scope precedence and could
  // otherwise override the trusted hook and fsmonitor settings below.
  for (const key of Object.keys(safeEnvironment)) {
    if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/i.test(key)) delete safeEnvironment[key];
  }
  const result = spawnSync('git', [
    '-c', `core.hooksPath=${trustedEmptyHooksDirectory()}`,
    '-c', 'core.fsmonitor=false',
    ...args,
  ], {
    cwd,
    input,
    env: safeEnvironment,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowExitCodes.includes(result.status)) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

export function gitBuffer(args: string[], { cwd }: { cwd?: string } = {}) {
  if (args.some((argument) => /^-c(?:$|.+)|^--config-env(?:=|$)/.test(argument))) {
    throw new Error('git helper does not permit caller-supplied command-scope configuration');
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/i.test(key)) delete env[key];
  }
  const result = spawnSync('git', [
    '-c', `core.hooksPath=${trustedEmptyHooksDirectory()}`, '-c', 'core.fsmonitor=false', ...args,
  ], { cwd, env, encoding: 'buffer' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString('utf8').trim()}`);
  return result.stdout;
}

export function verifyOrigin(project: string, root = git(['rev-parse', '--show-toplevel'])) {
  let remote: string;
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
  if (effectiveCanonical !== canonical) throw new Error('Git URL rewrite changes the configured evidence destination; refused');
  const pushInsteadOf = git(['config', '--null', '--get-regexp', '^url\\..*\\.pushinsteadof$'], {
    cwd: root,
    allowExitCodes: [1],
  });
  let longestMatch: { base: string; prefix: string } | null = null;
  for (const entry of pushInsteadOf.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\n');
    if (separator < 0) continue;
    const key = entry.slice(0, separator);
    const prefix = entry.slice(separator + 1);
    const configMatch = key.match(/^url\.(.*)\.pushinsteadof$/i);
    if (!configMatch || !canonical.startsWith(prefix)) continue;
    if (!longestMatch || prefix.length > longestMatch.prefix.length) longestMatch = { base: configMatch[1], prefix };
  }
  const effectivePush = longestMatch ? `${longestMatch.base}${canonical.slice(longestMatch.prefix.length)}` : canonical;
  if (effectivePush !== canonical) throw new Error('Git pushInsteadOf rewrite changes the configured evidence destination; refused');
  return { remote, pushUrl };
}
