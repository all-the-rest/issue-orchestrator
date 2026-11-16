import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyOrigin } from '../git/index.js';
import { gh } from '../providers/gh.js';
import type { RepositoryAccess } from '../providers/ticket-port.js';

/**
 * Permissions that let the ticket agent do its job: read/write repository
 * content, push branches and open pull requests. Read-only, triage, missing
 * and unknown permissions are refused instead of being probed.
 */
export const DISCOVERY_PUSH_PERMISSIONS = ['ADMIN', 'MAINTAIN', 'WRITE'] as const;

export function discoveryPermissionAllowsPush(permission: string | null | undefined): boolean {
  return typeof permission === 'string' &&
    (DISCOVERY_PUSH_PERMISSIONS as readonly string[]).includes(permission.toLocaleUpperCase());
}

export type RepositorySkipReason =
  | 'archived'
  | 'disabled'
  | 'fork'
  | 'issues-disabled'
  | 'permission'
  | 'invalid-project'
  | 'outside-owner'
  | 'configured-disabled'
  | 'duplicate';

export interface DiscoveredRepository {
  project: string;
  owner: string;
  repository: RepositoryAccess;
}

export interface RepositoryDiscoveryStore {
  /** Durable round-robin over owner names; least recently served first. */
  repositoryDiscoveryFairOrder(owners: string[]): string[];
  /** Record that an owner listing was attempted and advance its rotation. */
  recordRepositoryDiscovery(owner: string, at?: number): void;
  /** Durable round-robin over discovered project names; least recently served first. */
  repositoryDiscoveryProjectFairOrder?(projects: string[]): string[];
  /** Record that a discovered project was polled and advance its rotation. */
  recordRepositoryDiscoveryProject?(project: string, at?: number): void;
}

export interface RepositoryDiscoveryOutcome {
  /** Durable fair owner rotation first, then the provider's listing order. */
  projects: DiscoveredRepository[];
  /** Owners whose listing actually ran during this pass. */
  checkedOwners: string[];
  /** Owners deliberately deferred by the per-poll bound, for a later pass. */
  deferredOwners: string[];
  /**
   * Discovered projects above `maxProjectsPerPoll`; they rotate in by least
   * recently served order on later polls. Explicitly configured projects are
   * never deferred.
   */
  deferredProjects: string[];
  failures: Array<{ owner: string; error: string }>;
  skipped: Array<{ project: string; reason: RepositorySkipReason }>;
  /** Provider listings that ran, never repository content reads. */
  checks: number;
}

const validProject = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const validOwner = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function sanitizedError(error: unknown): string {
  // Provider errors can include repository names or response text. Keep the
  // discovery diagnostic content-free and bounded.
  const message = error instanceof Error ? error.message : String(error);
  return /^(repository owner|limit|invalid repository discovery)/i.test(message)
    ? message.slice(0, 200)
    : 'repository listing failed';
}

function normalizedOwners(owners: string[]): string[] {
  if (!Array.isArray(owners) || owners.length === 0) throw new Error('invalid repository discovery owners');
  const seen = new Set<string>();
  const result: string[] = [];
  for (const owner of owners) {
    if (typeof owner !== 'string' || !validOwner.test(owner)) {
      throw new Error('invalid repository discovery owner');
    }
    const key = owner.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(owner);
  }
  return result;
}

/**
 * Discover repositories the authenticated account can actually work in under
 * a bounded set of owners.
 *
 * Each owner is listed once per pass with an explicit limit, and only a bounded
 * number of owners is served per pass; the durable store rotates owners so a
 * large or repeatedly failing owner cannot starve the rest across polls and
 * restarts. The discovered projects are bounded as well: explicitly configured
 * projects are always returned, while newly discovered ones rotate in durable
 * least-recently-served order and only `maxProjectsPerPoll` of them are served
 * in one pass, so a large owner namespace cannot multiply every poll's issue
 * listings. A configured `repos.<project>` entry keeps its operator settings;
 * only missing repositories are added. Every access, archive, fork and
 * issue-setting condition fails closed by omission, never by enabling a
 * repository whose capability was not proven.
 */
export async function discoverRepositories(args: {
  owners: string[];
  list: (owner: string, limit: number) => Promise<RepositoryAccess[]>;
  limitPerOwner: number;
  maxOwnersPerPoll: number;
  /** Upper bound on newly discovered projects served in this pass. */
  maxProjectsPerPoll: number;
  includeForks?: boolean;
  /** True when the operator configured this project explicitly. */
  isConfigured?: (project: string) => boolean;
  /** True when an explicitly configured project is enabled. */
  isConfiguredEnabled?: (project: string) => boolean;
  store?: RepositoryDiscoveryStore;
  now?: number;
}): Promise<RepositoryDiscoveryOutcome> {
  const owners = normalizedOwners(args.owners);
  if (!Number.isSafeInteger(args.limitPerOwner) || args.limitPerOwner < 1 || args.limitPerOwner > 1_000) {
    throw new Error('invalid repository discovery limit');
  }
  if (!Number.isSafeInteger(args.maxOwnersPerPoll) || args.maxOwnersPerPoll < 1 || args.maxOwnersPerPoll > 100) {
    throw new Error('invalid repository discovery owner limit');
  }
  if (!Number.isSafeInteger(args.maxProjectsPerPoll) || args.maxProjectsPerPoll < 1 ||
      args.maxProjectsPerPoll > 100) {
    throw new Error('invalid repository discovery project limit');
  }
  const ordered = args.store ? args.store.repositoryDiscoveryFairOrder(owners) : owners;
  const selected = ordered.slice(0, args.maxOwnersPerPoll);
  const deferredOwners = ordered.slice(args.maxOwnersPerPoll);
  const outcome: RepositoryDiscoveryOutcome = {
    projects: [], checkedOwners: [], deferredOwners, deferredProjects: [], failures: [], skipped: [], checks: 0,
  };
  const seenProjects = new Set<string>();

  for (const owner of selected) {
    let repositories: RepositoryAccess[];
    try {
      repositories = await args.list(owner, args.limitPerOwner);
      if (!Array.isArray(repositories)) throw new Error('repository listing failed');
      outcome.checks += 1;
      outcome.checkedOwners.push(owner);
    } catch (error) {
      outcome.failures.push({ owner, error: sanitizedError(error) });
      // A failed owner still advances the durable rotation so one broken owner
      // cannot hold the front of the queue on every poll.
      try { args.store?.recordRepositoryDiscovery(owner, args.now); } catch { /* best effort */ }
      continue;
    }
    try { args.store?.recordRepositoryDiscovery(owner, args.now); } catch { /* best effort */ }

    for (const repository of repositories) {
      const project = repository?.project;
      if (typeof project !== 'string' || !validProject.test(project)) {
        outcome.skipped.push({ project: String(project ?? ''), reason: 'invalid-project' });
        continue;
      }
      const [projectOwner] = project.split('/');
      if (projectOwner.toLocaleLowerCase() !== owner.toLocaleLowerCase()) {
        outcome.skipped.push({ project, reason: 'outside-owner' });
        continue;
      }
      const key = project.toLocaleLowerCase();
      if (seenProjects.has(key)) {
        outcome.skipped.push({ project, reason: 'duplicate' });
        continue;
      }
      const configured = args.isConfigured?.(project) === true;
      if (configured && args.isConfiguredEnabled?.(project) === false) {
        outcome.skipped.push({ project, reason: 'configured-disabled' });
        continue;
      }
      if (repository.archived) {
        outcome.skipped.push({ project, reason: 'archived' });
        continue;
      }
      if (repository.disabled) {
        outcome.skipped.push({ project, reason: 'disabled' });
        continue;
      }
      if (!repository.issues) {
        outcome.skipped.push({ project, reason: 'issues-disabled' });
        continue;
      }
      if (!discoveryPermissionAllowsPush(repository.permission)) {
        outcome.skipped.push({ project, reason: 'permission' });
        continue;
      }
      if (repository.fork && args.includeForks !== true) {
        outcome.skipped.push({ project, reason: 'fork' });
        continue;
      }
      seenProjects.add(key);
      outcome.projects.push({ project, owner: projectOwner, repository });
    }
  }

  // Bound the discovered projects per pass. Explicitly configured projects are
  // always served; newly discovered ones rotate least-recently-served first so
  // no project starves while the cap keeps each poll's issue listings bounded.
  const explicitKeys = new Set<string>();
  const candidates: DiscoveredRepository[] = [];
  for (const entry of outcome.projects) {
    if (args.isConfigured?.(entry.project) === true) explicitKeys.add(entry.project.toLocaleLowerCase());
    else candidates.push(entry);
  }
  let projectOrder = candidates.map((entry) => entry.project);
  if (args.store?.repositoryDiscoveryProjectFairOrder) {
    try {
      const saved = args.store.repositoryDiscoveryProjectFairOrder(projectOrder);
      if (Array.isArray(saved) && saved.length === projectOrder.length) projectOrder = saved;
    } catch {
      // A rotation read failure must not hide accessible repositories; the
      // provider order still serves a bounded, deterministic subset.
    }
  }
  const served = projectOrder.slice(0, args.maxProjectsPerPoll);
  const servedKeys = new Set(served.map((project) => project.toLocaleLowerCase()));
  outcome.deferredProjects = projectOrder.slice(args.maxProjectsPerPoll);
  outcome.projects = outcome.projects.filter((entry) =>
    explicitKeys.has(entry.project.toLocaleLowerCase()) ||
    servedKeys.has(entry.project.toLocaleLowerCase()));
  if (args.store?.recordRepositoryDiscoveryProject) {
    for (const project of served) {
      try { args.store.recordRepositoryDiscoveryProject(project, args.now); } catch { /* best effort */ }
    }
  }
  return outcome;
}

export interface ManagedCheckoutDependencies {
  /** Reject symlinks/unowned/non-private directories and return the real path. */
  ensurePrivateDirectory(directory: string): string;
  clone?(project: string, directory: string): void;
  verifyOrigin?(project: string, directory: string): unknown;
}

function defaultClone(project: string, directory: string): void {
  // `gh repo clone` uses the already configured provider login. A failure is
  // reported generically; this path never tries another credential or login.
  gh(['repo', 'clone', project, directory]);
}

/**
 * Prepare the private base checkout for a discovered repository. The clone is
 * created under a unique temporary sibling and atomically renamed, so two
 * pollers cannot adopt a half-written checkout. Existing directories must
 * already be a private checkout with the exact configured origin; nothing is
 * cloned over an operator-visible path.
 */
export function ensureManagedRepositoryCheckout(args: {
  project: string;
  directory: string;
  deps: ManagedCheckoutDependencies;
}): string {
  const { project, directory, deps } = args;
  const parent = deps.ensurePrivateDirectory(path.dirname(directory));
  const verify = deps.verifyOrigin ?? ((expected: string, root: string) => verifyOrigin(expected, root));
  if (fs.existsSync(directory)) {
    deps.ensurePrivateDirectory(directory);
    if (!fs.existsSync(path.join(directory, '.git'))) {
      throw new Error(`managed checkout for ${project} is not a Git checkout`);
    }
    verify(project, directory);
    return fs.realpathSync(directory);
  }
  const temporary = path.join(parent, `.${path.basename(directory)}.clone-${process.pid}-${randomUUID()}`);
  try {
    (deps.clone ?? defaultClone)(project, temporary);
    deps.ensurePrivateDirectory(temporary);
    if (!fs.existsSync(path.join(temporary, '.git'))) throw new Error('clone did not create a checkout');
    verify(project, temporary);
    fs.renameSync(temporary, directory);
  } catch {
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* private temporary */ }
    // Another poller may have won the rename race; accept only a fully valid
    // checkout, otherwise fail closed without touching it.
    if (fs.existsSync(directory)) {
      deps.ensurePrivateDirectory(directory);
      if (fs.existsSync(path.join(directory, '.git'))) {
        verify(project, directory);
        return fs.realpathSync(directory);
      }
    }
    throw new Error(`managed checkout for ${project} could not be prepared; ` +
      'verify operator access to the repository and the managed workspace_root, then retry');
  }
  return fs.realpathSync(directory);
}
