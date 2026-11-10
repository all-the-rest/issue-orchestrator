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

function validateReferences(value: unknown) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new AgentResultContractError('result.json field "references" must be an array of at most 20 GitHub links');
  }
  return value.map((item, index) => {
    if (!isRecord(item) || Object.keys(item).length !== 2 ||
        !['kind', 'url'].every((key) => key in item) ||
        !['pull_request', 'checks'].includes(String(item.kind)) ||
        typeof item.url !== 'string' || item.url.length > 2048) {
      throw new AgentResultContractError(`result.json field "references[${index}]" is invalid`);
    }
    let url: URL;
    try { url = new URL(item.url); } catch {
      throw new AgentResultContractError(`result.json field "references[${index}].url" is invalid`);
    }
    const pullRequest = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/i.test(url.pathname);
    const pullChecks = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/checks\/?$/i.test(url.pathname);
    const actionRun = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*\/?$/i.test(url.pathname);
    const validPath = item.kind === 'pull_request' ? pullRequest : pullChecks || actionRun;
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password ||
        url.search || url.hash || !validPath) {
      throw new AgentResultContractError(`result.json field "references[${index}].url" must be a safe GitHub PR/check URL`);
    }
    return { kind: item.kind as 'pull_request' | 'checks', url: url.toString() };
  });
}

/** Validate the shared agent result contract independently of any adapter. */
export function validateAgentResult(value: unknown): AgentResult {
  if (!isRecord(value)) throw new AgentResultContractError('result.json must contain a JSON object');
  const expected = ['status', 'summary', 'changed_files', 'commands', 'acceptance', 'blocked_reason', 'evidence_dir', 'verdict'];
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  const hasReferences = Object.hasOwn(value, 'references');
  if ((!hasReferences && keys.length !== expected.length) ||
      (hasReferences && (keys.length !== expected.length + 1 || !keys.includes('references'))) ||
      sortedExpected.some((key) => !keys.includes(key))) {
    throw new AgentResultContractError(`result.json must contain exactly: ${expected.join(', ')} and optional references`);
  }
  if (!['DONE', 'BLOCKED', 'CHANGES_REQUIRED', 'NEEDS_INFO'].includes(String(value.status))) {
    throw new AgentResultContractError('result.json status must be DONE, BLOCKED, CHANGES_REQUIRED or NEEDS_INFO');
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
  if (['BLOCKED', 'NEEDS_INFO'].includes(status) && blockedReason === null) {
    throw new AgentResultContractError(`${status} result requires blocked_reason (put questions here; do not ask)`);
  }
  if (!['BLOCKED', 'NEEDS_INFO'].includes(status) && blockedReason !== null) {
    throw new AgentResultContractError('blocked_reason must be null unless status is BLOCKED or NEEDS_INFO');
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
    ...(hasReferences ? { references: validateReferences(value.references) } : {}),
  };
}
