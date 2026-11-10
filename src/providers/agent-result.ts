import type { AgentResult, AgentResultStatus } from './ports.js';

/** Shared adapter error base, independent of any concrete harness. */
export class AgentRunnerError extends Error {
  readonly code: string;
  readonly sessionId?: string;

  constructor(code: string, message: string, sessionId?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AgentRunnerError';
    this.code = code;
    this.sessionId = sessionId;
  }
}

/** A malformed adapter result that must not enter workflow policy. */
export class AgentResultContractError extends AgentRunnerError {
  constructor(message: string, sessionId?: string, cause?: unknown) {
    super('INVALID_AGENT_RESULT', message, sessionId, cause);
    this.name = 'AgentResultContractError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentResultContractError(`result.json field "${field}" must be a non-empty string`);
  }
  return value;
}

/** Validate the shared agent result contract independently of any adapter. */
export function validateAgentResult(value: unknown): AgentResult {
  if (!isRecord(value)) throw new AgentResultContractError('result.json must contain a JSON object');
  const expected = ['status', 'summary', 'changed_files', 'commands', 'acceptance', 'blocked_reason', 'evidence_dir', 'verdict'];
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new AgentResultContractError(`result.json must contain exactly: ${expected.join(', ')}`);
  }
  if (!['DONE', 'BLOCKED', 'CHANGES_REQUIRED'].includes(String(value.status))) {
    throw new AgentResultContractError('result.json status must be DONE, BLOCKED or CHANGES_REQUIRED');
  }
  const stringList = (field: string) => {
    const list = value[field];
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      throw new AgentResultContractError(`result.json field "${field}" must be an array of non-empty strings`);
    }
    return [...list] as string[];
  };
  const status = value.status as AgentResultStatus;
  const blockedReason = value.blocked_reason;
  if (blockedReason !== null && (typeof blockedReason !== 'string' || blockedReason.trim().length === 0)) {
    throw new AgentResultContractError('result.json field "blocked_reason" must be a non-empty string or null');
  }
  if (status === 'BLOCKED' && blockedReason === null) {
    throw new AgentResultContractError('BLOCKED result requires blocked_reason (put questions here; do not ask)');
  }
  if (status !== 'BLOCKED' && blockedReason !== null) {
    throw new AgentResultContractError('blocked_reason must be null unless status is BLOCKED');
  }
  const evidenceDir = value.evidence_dir;
  if (evidenceDir !== null && (typeof evidenceDir !== 'string' || evidenceDir.trim().length === 0)) {
    throw new AgentResultContractError('result.json field "evidence_dir" must be a non-empty string or null');
  }
  return {
    status,
    summary: requireNonEmptyString(value.summary, 'summary'),
    changed_files: stringList('changed_files'),
    commands: stringList('commands'),
    acceptance: stringList('acceptance'),
    blocked_reason: blockedReason as string | null,
    evidence_dir: evidenceDir as string | null,
    verdict: requireNonEmptyString(value.verdict, 'verdict'),
  };
}
