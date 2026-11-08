import { spawnSync } from 'node:child_process';

export function probeExecutable(name: string, args: string[]) {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 5000, env: process.env });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { name, status: 'missing', message: `Install ${name} and ensure it is on PATH.` };
  return { name, status: result.status === 0 ? 'ok' : 'failed', message: result.status === 0 ? 'available' : `${name} unavailable or command failed; check installation and local authentication.` };
}

export function probeGithubIdentity(configured: string[]) {
  const result = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 5000, env: process.env });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { name: 'gh', status: 'missing', message: 'Install gh and ensure it is on PATH.' };
  const identity = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(/Logged in to [^\n]* account ([^\s(]+)/i)?.[1];
  return { name: 'gh', status: result.status === 0 && !!identity && configured.includes(identity) ? 'ok' : 'failed', message: result.status !== 0 ? 'Authenticate gh without changing accounts.' : !identity ? 'Could not determine active gh account.' : !configured.includes(identity) ? `Active gh account does not match configured accounts (${configured.join(', ')}).` : 'active account matches configuration' };
}

export function probeGitlabIdentity(configured: string[]) {
  const result = spawnSync('glab', ['auth', 'status'], { encoding: 'utf8', timeout: 5000, env: process.env });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return { name: 'glab', status: 'missing', message: 'Install glab and ensure it is on PATH.' };
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const identity = output.match(/(?:Logged in to .*? as|Active account:)\s*([A-Za-z0-9_.-]+)/i)?.[1];
  return {
    name: 'glab',
    status: result.status === 0 && !!identity && configured.includes(identity) ? 'ok' : 'failed',
    message: result.status !== 0 ? 'Authenticate glab without changing accounts.'
      : !identity ? 'Could not determine active glab account.'
        : !configured.includes(identity) ? `Active glab account does not match configured accounts (${configured.join(', ')}).`
          : 'active account matches configuration',
  };
}
