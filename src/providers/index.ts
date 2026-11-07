import { githubTracker } from './github-tracker.js';
import { githubCodeHost } from './github-codehost.js';
import { agentRunnerStub, codeHostStub, trackerStub } from './stubs.js';
import type { AgentRunner, CodeHost, Tracker } from './ports.js';

const trackers: Record<string, Tracker> = {
  github: githubTracker,
  gitlab: trackerStub('gitlab'),
  jira: trackerStub('jira'),
};
const codeHosts: Record<string, CodeHost> = {
  github: githubCodeHost,
  gitlab: codeHostStub('gitlab'),
  jira: codeHostStub('jira'),
};
const agentRunners: Record<string, AgentRunner> = {
  opencode: agentRunnerStub('opencode'),
};

export const providerCapabilities = Object.freeze({
  trackers: Object.fromEntries(Object.entries(trackers).map(([name, adapter]) => [name, adapter.capabilities])),
  codeHosts: Object.fromEntries(Object.entries(codeHosts).map(([name, adapter]) => [name, adapter.capabilities])),
  agentRunners: Object.fromEntries(Object.entries(agentRunners).map(([name, adapter]) => [name, adapter.capabilities])),
});

function resolve<T>(registry: Record<string, T>, port: string, name: string): T {
  const adapter = registry[name];
  if (!adapter) {
    throw new Error(`Unknown ${port} "${name}". Registered: ${Object.keys(registry).join(', ')}`);
  }
  return adapter;
}

export function getTracker(name = 'github') {
  return resolve(trackers, 'tracker', name);
}

export function getCodeHost(name = 'github') {
  return resolve(codeHosts, 'code host', name);
}

export function getAgentRunner(name = 'opencode') {
  return resolve(agentRunners, 'agent runner', name);
}

export { UnsupportedCapabilityError } from './ports.js';
export type { AgentRunner, CapabilityDescriptor, CodeHost, Tracker } from './ports.js';
