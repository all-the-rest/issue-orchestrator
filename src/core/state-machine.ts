export const WORKFLOW_STATES = [
  'NEW', 'TRIAGED', 'READY', 'CLAIMED', 'ISOLATED', 'BEFORE_CAPTURED',
  'IMPLEMENTING', 'IMPLEMENTED', 'CHANGE_OPEN', 'EVIDENCE_PUBLISHED',
  'REVIEWING', 'REVIEW_APPROVED', 'CHECKS_GREEN', 'MERGING', 'DONE',
  'NEEDS_INFO', 'BLOCKED', 'REVIEW', 'FAILED', 'CANCELLED', 'STALE',
] as const;

export type WorkflowState = typeof WORKFLOW_STATES[number];
export type WorkflowActor = 'cli' | 'agent' | 'human';

const TERMINAL = new Set<WorkflowState>([
  'DONE', 'NEEDS_INFO', 'BLOCKED', 'REVIEW', 'FAILED', 'CANCELLED', 'STALE',
]);

const NEXT: Record<WorkflowState, Partial<Record<WorkflowState, readonly WorkflowActor[]>>> = {
  NEW: { TRIAGED: ['agent'] },
  TRIAGED: { READY: ['agent', 'cli'], ISOLATED: ['agent'] },
  READY: { CLAIMED: ['cli'] },
  CLAIMED: { TRIAGED: ['agent'] },
  ISOLATED: { BEFORE_CAPTURED: ['agent', 'cli'] },
  BEFORE_CAPTURED: { IMPLEMENTING: ['agent'] },
  IMPLEMENTING: { IMPLEMENTED: ['agent'] },
  IMPLEMENTED: { CHANGE_OPEN: ['cli'] },
  CHANGE_OPEN: { EVIDENCE_PUBLISHED: ['cli'] },
  EVIDENCE_PUBLISHED: { REVIEWING: ['agent', 'cli'] },
  REVIEWING: { REVIEW_APPROVED: ['cli', 'human'] },
  REVIEW_APPROVED: { CHECKS_GREEN: ['cli'] },
  CHECKS_GREEN: { MERGING: ['cli'] },
  MERGING: { DONE: ['cli'] },
  DONE: {},
  NEEDS_INFO: {},
  BLOCKED: {},
  REVIEW: {},
  FAILED: {},
  CANCELLED: {},
  STALE: {},
};

const OUTCOMES: Readonly<Record<WorkflowState, readonly WorkflowActor[]>> = {
  NEW: [], TRIAGED: [], READY: [], CLAIMED: [], ISOLATED: [], BEFORE_CAPTURED: [],
  IMPLEMENTING: [], IMPLEMENTED: [], CHANGE_OPEN: [], EVIDENCE_PUBLISHED: [],
  REVIEWING: [], REVIEW_APPROVED: [], CHECKS_GREEN: [], MERGING: [], DONE: [],
  NEEDS_INFO: ['agent', 'cli', 'human'], BLOCKED: ['agent', 'cli', 'human'],
  REVIEW: ['agent', 'cli', 'human'], FAILED: ['agent', 'cli'],
  CANCELLED: ['cli', 'human'], STALE: ['cli'],
};

export function isWorkflowState(value: string): value is WorkflowState {
  return (WORKFLOW_STATES as readonly string[]).includes(value);
}

export function isTerminalWorkflowState(value: WorkflowState) {
  return TERMINAL.has(value);
}

export function isAllowedWorkflowTransition(from: string, to: string, actor: string) {
  if (!isWorkflowState(from) || !isWorkflowState(to) || !['cli', 'agent', 'human'].includes(actor)) return false;
  if (from === to || TERMINAL.has(from)) return false;
  const stepActors = NEXT[from][to];
  if (stepActors?.includes(actor as WorkflowActor)) return true;
  return OUTCOMES[to].includes(actor as WorkflowActor);
}

export function assertWorkflowTransition(from: string, to: string, actor: string) {
  if (!isAllowedWorkflowTransition(from, to, actor)) {
    throw new Error(`Invalid workflow transition ${from} -> ${to} for actor ${actor}`);
  }
}
