import assert from 'node:assert/strict';
import { validateAgentResult, AgentResultContractError } from '../dist/providers/agent-result.js';

// Shared contract suite: adapters must accept this exact result shape and
// reject ambiguous or incomplete outcomes before workflow policy sees them.
const done = {
  status: 'DONE', summary: 'completed', changed_files: [], commands: [], acceptance: [],
  blocked_reason: null, evidence_dir: null, verdict: 'PASS',
};
assert.deepEqual(validateAgentResult(done), done);
assert.equal(validateAgentResult({ ...done, status: 'BLOCKED', blocked_reason: 'needs input' }).status, 'BLOCKED');
assert.equal(validateAgentResult({ ...done, status: 'NEEDS_INFO', blocked_reason: 'needs input' }).status, 'NEEDS_INFO');
assert.deepEqual(validateAgentResult({ ...done, references: [
  { kind: 'pull_request', url: 'https://github.com/owner/repo/pull/7' },
  { kind: 'checks', url: 'https://github.com/owner/repo/pull/7/checks' },
] }).references, [
  { kind: 'pull_request', url: 'https://github.com/owner/repo/pull/7' },
  { kind: 'checks', url: 'https://github.com/owner/repo/pull/7/checks' },
]);
for (const invalid of [
  { ...done, unexpected: true },
  { ...done, blocked_reason: '' },
  { ...done, status: 'BLOCKED' },
  { ...done, changed_files: [''] },
  { ...done, references: [{ kind: 'pull_request', url: 'https://evil.example/owner/repo/pull/7' }] },
  { ...done, references: [{ kind: 'checks', url: 'https://github.com/owner/repo/pull/7/checks?token=secret' }] },
]) {
  assert.throws(() => validateAgentResult(invalid), AgentResultContractError);
}

// Deliberately test-only reference adapter. It demonstrates the port's basic
// role/lifecycle/result boundary without claiming process isolation or safety.
class MemoryReferenceRunner {
  name = 'memory-reference';
  sessions = new Map();
  async createSession(args) {
    assert.ok(['triage', 'builder', 'ticket-agent', 'verifier', 'reviewer'].includes(args.role));
    const session = { runner: this.name, externalSessionId: `memory-${this.sessions.size + 1}`,
      jobId: args.jobId, role: args.role, model: args.model, worktree: args.worktree,
      status: 'CREATED', startedAt: new Date().toISOString(), endedAt: null };
    this.sessions.set(session.externalSessionId, { session, result: null });
    return session;
  }
  async run(args) {
    const record = this.sessions.get(args.sessionId);
    assert.ok(record, 'unknown sessions are rejected');
    record.session.status = 'RUNNING';
    record.result = validateAgentResult(done);
    record.session.status = record.result.status;
    record.session.endedAt = new Date().toISOString();
    return record.result;
  }
  resume(args) { return this.run(args); }
  async abort({ sessionId }) {
    const record = this.sessions.get(sessionId);
    if (!record || record.session.endedAt) return false;
    record.session.status = 'ABORTED';
    record.session.endedAt = new Date().toISOString();
    return true;
  }
  async getResult({ sessionId }) {
    const record = this.sessions.get(sessionId);
    return record?.result ?? null;
  }
}

const reference = new MemoryReferenceRunner();
await assert.rejects(reference.createSession({ jobId: 1, role: 'admin', model: 'test/model', worktree: '/tmp/worktree' }));
const session = await reference.createSession({ jobId: 1, role: 'verifier', model: 'test/model', worktree: '/tmp/worktree' });
assert.equal(session.runner, 'memory-reference');
assert.equal(await reference.getResult({ sessionId: session.externalSessionId }), null);
assert.deepEqual(await reference.run({ sessionId: session.externalSessionId, prompt: 'test' }), done);
assert.equal((await reference.getResult({ sessionId: session.externalSessionId })).status, 'DONE');
await assert.rejects(reference.run({ sessionId: 'missing', prompt: 'test' }));
const aborted = await reference.createSession({ jobId: 2, role: 'reviewer', model: 'test/model', worktree: '/tmp/worktree' });
assert.equal(await reference.abort({ sessionId: aborted.externalSessionId }), true);
assert.equal(await reference.abort({ sessionId: aborted.externalSessionId }), false);
console.log('PASS shared AgentRunner result contract');
