function slot(method: string): never {
  throw new Error(
    `Provider "gitlab" is a contract slot: ${method} is not implemented. ` +
    'Implement it in src/providers/gitlab.ts (see references/providers.md).'
  );
}

function encodePath(filePath: string) {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

export const gitlab = {
  name: 'gitlab',
  changeRequestTerm: 'MR',
  verifyAccount: () => slot('verifyAccount'),
  listIssues: () => slot('listIssues'),
  viewIssue: () => slot('viewIssue'),
  addLabel: () => slot('addLabel'),
  removeLabel: () => slot('removeLabel'),
  comment: () => slot('comment'),
  viewChange: () => slot('viewChange'),
  checks: () => slot('checks'),
  merge: () => slot('merge'),
  createChange: () => slot('createChange'),
  ensureLabel: () => slot('ensureLabel'),
  rawUrl({ project, ref, path: filePath }: { project: string; ref: string; path: string }) {
    return `https://gitlab.com/${project}/-/raw/${ref}/${encodePath(filePath)}`;
  },
};
