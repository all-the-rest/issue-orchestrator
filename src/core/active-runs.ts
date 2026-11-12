/**
 * Process-wide registry of in-flight agent runs. Parallel ticket sessions and
 * the legacy single builder all register here so one SIGTERM/SIGINT aborts every
 * active run instead of only the most recently started one.
 */
export interface ActiveAgentRun {
  runner: { abort(input: { sessionId: string }): Promise<boolean> };
  sessionId: string;
  promise: Promise<unknown>;
}

let shutdownSignal: NodeJS.Signals | null = null;
const activeAgentRuns = new Set<ActiveAgentRun>();

export function trackAgentRun(run: ActiveAgentRun): () => void {
  activeAgentRuns.add(run);
  return () => { activeAgentRuns.delete(run); };
}

/**
 * Register a run before it starts. `start` releases the gate after a final
 * shutdown check; `fail` settles the tracked promise when the runner is never
 * started, so a concurrent requestRunShutdown cannot wait forever.
 */
export function createTrackedAgentRun<T>(
  runner: ActiveAgentRun['runner'],
  sessionId: string,
  startAgent: () => Promise<T>,
): { promise: Promise<T>; start: () => void; fail: (error: unknown) => void; release: () => void } {
  let start!: () => void;
  let fail!: (error: unknown) => void;
  const gate = new Promise<void>((resolve, reject) => { start = resolve; fail = reject; });
  const promise = gate.then(startAgent);
  // A shutdown can be snapshotted just before registration, so a later `fail`
  // may reject this promise with no requestRunShutdown awaiting it. Observe the
  // rejection here to avoid a process-killing unhandled rejection; callers that
  // await `promise` still receive the original error.
  void promise.catch(() => undefined);
  const release = trackAgentRun({ runner, sessionId, promise });
  return { promise, start, fail, release };
}

export function shutdownRequested(): NodeJS.Signals | null {
  return shutdownSignal;
}

export async function requestRunShutdown(signal: NodeJS.Signals): Promise<void> {
  shutdownSignal ??= signal;
  const runs = [...activeAgentRuns];
  if (!runs.length) return;
  // Abort every session before waiting for any single process group to exit.
  const aborts = await Promise.allSettled(runs.map((run) => run.runner.abort({ sessionId: run.sessionId })));
  await Promise.allSettled(runs.map((run) => run.promise));
  const failed = aborts.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}
