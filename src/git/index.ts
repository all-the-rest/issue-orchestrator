import { spawnSync } from 'node:child_process';

export function git(
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
