import { descriptor, unsupported, type AgentRunner, type CodeHost, type Tracker } from './ports.js';

const TRACKER_METHODS = ['verifyAccount', 'listWorkItems', 'getWorkItem', 'updateWorkItem', 'setLabels', 'getComments', 'publishComment', 'hasLabel', 'getLabel', 'ensureLabel'];
const CODE_HOST_METHODS = ['verifyAccount', 'verifyRepository', 'createChange', 'getChange', 'findChange', 'getReviewStatus', 'getChecks', 'merge', 'evidenceUrl', 'verifyEvidence', 'publishComment'];

export function trackerStub(name: string): Tracker {
  const missing = TRACKER_METHODS;
  return {
    name,
    capabilities: descriptor(name, 'Tracker', { workItems: false, labels: false, comments: false }, missing),
    verifyAccount: unsupported(name, 'Tracker', 'verifyAccount'),
    listWorkItems: unsupported(name, 'Tracker', 'listWorkItems'),
    getWorkItem: unsupported(name, 'Tracker', 'getWorkItem'),
    updateWorkItem: unsupported(name, 'Tracker', 'updateWorkItem'),
    setLabels: unsupported(name, 'Tracker', 'setLabels'),
    getComments: unsupported(name, 'Tracker', 'getComments'),
    publishComment: unsupported(name, 'Tracker', 'publishComment'),
    hasLabel: unsupported(name, 'Tracker', 'hasLabel'),
    getLabel: unsupported(name, 'Tracker', 'getLabel'),
    ensureLabel: unsupported(name, 'Tracker', 'ensureLabel'),
  };
}

export function codeHostStub(name: string): CodeHost {
  const missing = CODE_HOST_METHODS;
  return {
    name,
    capabilities: descriptor(name, 'CodeHost', {
      changes: false, checks: false, nativeApproval: false, mergeMethods: [], evidence: 'none',
      repositoryVerification: false,
    }, missing),
    verifyAccount: unsupported(name, 'CodeHost', 'verifyAccount'),
    verifyRepository: unsupported(name, 'CodeHost', 'verifyRepository'),
    createChange: unsupported(name, 'CodeHost', 'createChange'),
    getChange: unsupported(name, 'CodeHost', 'getChange'),
    findChange: unsupported(name, 'CodeHost', 'findChange'),
    getReviewStatus: unsupported(name, 'CodeHost', 'getReviewStatus'),
    getChecks: unsupported(name, 'CodeHost', 'getChecks'),
    merge: unsupported(name, 'CodeHost', 'merge'),
    evidenceUrl: unsupported(name, 'CodeHost', 'evidenceUrl'),
    verifyEvidence: unsupported(name, 'CodeHost', 'verifyEvidence'),
    publishComment: unsupported(name, 'CodeHost', 'publishComment'),
  };
}

export function agentRunnerStub(name: string): AgentRunner {
  const missing = ['createSession', 'run', 'resume', 'abort', 'getResult'];
  return {
    name,
    capabilities: descriptor(name, 'AgentRunner', { sessions: false, run: false, resume: false, abort: false, result: false }, missing),
    createSession: unsupported(name, 'AgentRunner', 'createSession'),
    run: unsupported(name, 'AgentRunner', 'run'),
    resume: unsupported(name, 'AgentRunner', 'resume'),
    abort: unsupported(name, 'AgentRunner', 'abort'),
    getResult: unsupported(name, 'AgentRunner', 'getResult'),
  };
}
