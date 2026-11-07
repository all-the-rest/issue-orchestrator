import { spawnSync } from 'node:child_process';

export function gh(
  args: string[],
  { input, allowFail = false, env }: {
    input?: string;
    allowFail?: boolean;
    env?: Record<string, string>;
  } = {},
) {
  const childEnv = { ...process.env, ...(env ?? {}) };
  const result = spawnSync('gh', args, { input, encoding: 'utf8', env: childEnv });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`gh ${args.join(' ')} failed (${result.status}): ${detail}`);
  }
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

export function ghJson<T = unknown>(args: string[]): T {
  return JSON.parse(gh(args).stdout || '[]') as T;
}

export function verifyGithubAccount(user: string) {
  if (!user || typeof user !== 'string') throw new Error('a GitHub account is required');
  const active = gh(['api', 'user', '--jq', '.login']).stdout;
  if (active.toLowerCase() !== user.toLowerCase()) {
    throw new Error(`Active gh account is "${active || 'unknown'}", but ${user} is configured; select the correct account before running`);
  }
  return active;
}
