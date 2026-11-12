import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteStore } from '../dist/core/persistence.js';
import { createTicketDispatch } from '../dist/core/commands.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-dispatch-alias-'));
const store = new SQLiteStore(path.join(root, 'dispatch.sqlite3'));
const worktree = path.join(root, 'worktree');
fs.mkdirSync(worktree, { mode: 0o700 });
const handoffId = 'c'.repeat(64);
const jobId = store.ensureTicketAgentJob({ handoffId, project: 'Owner/Repo', issue: 5,
  configFile: path.join(root, 'config.jsonc') });
store.createAgentSession({ jobId, externalSessionId: 'persisted-ticket-session', role: 'ticket-agent',
  model: 'test/model', worktree, ndjsonPath: path.join(root, 'events.ndjson'),
  stderrPath: path.join(root, 'stderr.log') });

let resumed = null;
const runner = {
  async resume(args) {
    resumed = args;
    return { status: 'DONE', summary: 'resumed', changed_files: [], commands: [], acceptance: [],
      blocked_reason: null, evidence_dir: null, verdict: 'DONE' };
  },
  async run() { throw new Error('resume should be used for a persisted session'); },
  async createSession() { throw new Error('existing session must not be recreated'); },
  async getResult() { return null; },
};
const cfg = { __file: path.join(root, 'config.jsonc'), model: 'test/model', accounts: [] };
const request = {
  handoffId,
  sessionId: 'persisted-ticket-session',
  bootstrap: 'system prompt',
  instruction: 'continue',
  continueCompleted: true,
  turnId: 'turn-1',
  message: JSON.stringify({
    protocol: 'issue-orchestrator.ticket-event.v1',
    kind: 'update',
    project: 'Owner/Repo',
    issue: 5,
    ticketUrl: 'https://github.com/Owner/Repo/issues/5',
    changedFields: [],
    events: [],
  }),
};

try {
  const dispatch = createTicketDispatch({ cfg, rc: {}, project: 'owner/repo', issue: 5, worktree, store,
    runner, role: 'ticket-agent' });
  const result = await dispatch(request);
  assert.equal(result.sessionId, 'persisted-ticket-session');
  assert.equal(result.result.status, 'DONE');
  assert.equal(resumed?.sessionId, 'persisted-ticket-session');
  assert.equal(store.ensureTicketAgentJob({ handoffId, project: 'owner/repo', issue: 5 }), jobId,
    'the alias dispatch must reuse the original job anchor and session');
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('ticket dispatch resumes a persisted session across project casing');
