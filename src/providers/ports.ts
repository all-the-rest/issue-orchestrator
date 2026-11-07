export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface ProviderUser {
  login?: string;
}

export type ProviderAuthor = string | ProviderUser | null;

export interface ProviderLabel {
  name: string;
  color?: string;
  description?: string;
}

export interface ProviderComment {
  body?: string;
  author?: ProviderAuthor;
  createdAt?: string;
}

export interface WorkItem {
  number: number;
  title?: string;
  body?: string;
  author?: ProviderAuthor;
  labels?: Array<string | Pick<ProviderLabel, 'name'>>;
  comments?: ProviderComment[];
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  state?: string;
}

export interface ChangeReview {
  author?: ProviderAuthor;
  state?: string;
  submittedAt?: string;
  commit?: string | { oid?: string };
}

export interface ChangeRequest {
  number: number;
  state?: string;
  isDraft?: boolean;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  body?: string;
  author?: ProviderAuthor;
  comments?: ProviderComment[];
  reviews?: ChangeReview[];
  reviewDecision?: string;
  mergeable?: string | boolean | null;
  mergeStateStatus?: string | null;
}

export interface ChangeReference {
  url: string | null;
  number: number;
  head: string;
  base: string;
  state?: string;
  reused: boolean;
}

export interface ChangeCreationResult {
  url: string | null;
  number: number | null;
  head: string;
  base: string;
  reused: boolean;
}

export interface CapabilityDescriptor {
  provider: string;
  port: 'Tracker' | 'CodeHost' | 'AgentRunner';
  capabilities: Record<string, boolean | string | readonly string[]>;
  unsupported: readonly string[];
}

export interface Tracker {
  readonly name: string;
  readonly capabilities: CapabilityDescriptor;
  verifyAccount(account: string): string;
  listWorkItems(args: { project: string; limit?: number }): WorkItem[];
  getWorkItem(args: { project: string; number: number }): WorkItem;
  updateWorkItem(args: { project: string; number: number; fields: Record<string, unknown> }): unknown;
  setLabels(args: { project: string; number: number; add?: string[]; remove?: string[] }): unknown;
  getComments(args: { project: string; number: number }): ProviderComment[];
  publishComment(args: { project: string; number: number; body: string }): unknown;
  hasLabel(args: { project: string; name: string }): boolean;
  getLabel(args: { project: string; name: string }): ProviderLabel | null;
  ensureLabel(args: { project: string; name: string; color: string; description: string }): unknown;
}

export interface CodeHost {
  readonly name: string;
  readonly capabilities: CapabilityDescriptor;
  verifyAccount(account: string): string;
  verifyRepository(args: { project: string }): { remote: string; pushUrl: string };
  createChange(args: { project: string; head: string; base: string; title: string; bodyFile: string; draft?: boolean }): ChangeCreationResult;
  getChange(args: { project: string; number: number }): ChangeRequest;
  findChange(args: { project: string; head: string; base: string }): ChangeReference | null;
  getReviewStatus(args: { project: string; number: number }): {
    decision: string | null;
    reviews: ChangeReview[];
    author: ProviderAuthor;
    head: string | null;
  };
  getChecks(args: { project: string; number: number; required?: boolean; watch?: boolean; interval?: number }): number;
  merge(args: { project: string; number: number; method?: MergeMethod; headSha: string }): { method: MergeMethod };
  evidenceUrl(args: { project: string; ref: string; path: string }): string;
  verifyEvidence(args: { project: string; commit: string; issue: number; change: number; head: string }): {
    commit: string;
    manifest: Record<string, unknown>;
    files: number;
  };
  publishComment(args: { project: string; number: number; body: string }): unknown;
}

export interface AgentRunner {
  readonly name: string;
  readonly capabilities: CapabilityDescriptor;
  createSession(args: Record<string, unknown>): unknown;
  run(args: Record<string, unknown>): unknown;
  resume(args: Record<string, unknown>): unknown;
  abort(args: Record<string, unknown>): unknown;
  getResult(args: Record<string, unknown>): unknown;
}

export class UnsupportedCapabilityError extends Error {
  readonly provider: string;
  readonly port: CapabilityDescriptor['port'];
  readonly capability: string;

  constructor(provider: string, port: CapabilityDescriptor['port'], capability: string) {
    super(`Provider "${provider}" does not support ${port} capability "${capability}"`);
    this.name = 'UnsupportedCapabilityError';
    this.provider = provider;
    this.port = port;
    this.capability = capability;
  }
}

export function unsupported<T extends (...args: never[]) => unknown>(
  provider: string,
  port: CapabilityDescriptor['port'],
  capability: string,
): T {
  return (() => { throw new UnsupportedCapabilityError(provider, port, capability); }) as unknown as T;
}

export function descriptor(
  provider: string,
  port: CapabilityDescriptor['port'],
  capabilities: CapabilityDescriptor['capabilities'],
  unsupportedMethods: string[] = [],
): CapabilityDescriptor {
  return Object.freeze({ provider, port, capabilities: Object.freeze({ ...capabilities }), unsupported: Object.freeze([...unsupportedMethods]) });
}
