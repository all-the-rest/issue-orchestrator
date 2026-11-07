import { createHash } from 'node:crypto';
import type { SQLiteStore } from './persistence.js';

export type SideEffectObservation =
  | { state: 'applied'; result: unknown }
  | { state: 'absent' }
  | { state: 'unknown'; reason: string };

export function sideEffectKey(store: SQLiteStore, ownerToken: string | undefined, kind: string, identity: unknown) {
  const scope = ownerToken ? `job-${store.jobIdForOwner(ownerToken)}` : 'global';
  const serialized = JSON.stringify(identity);
  if (serialized === undefined) throw new Error('side-effect identity must be JSON serializable');
  const identityHash = createHash('sha256').update(serialized).digest('hex');
  return `${scope}:${kind}:${identityHash}`;
}

/**
 * Journal intent before an external write. A pending write is only repeated
 * after its adapter proves the effect is absent; an unknown observation fails
 * closed. The post-write observation is what is persisted as the result.
 */
export function runJournaledSideEffect<T>(input: {
  store: SQLiteStore;
  ownerToken?: string;
  idempotencyKey: string;
  kind: string;
  intent: unknown;
  reconcile: () => SideEffectObservation;
  apply: () => T;
}): { value: T | unknown; reconciled: boolean } {
  input.store.beginSideEffect({
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    intent: input.intent,
    ownerToken: input.ownerToken,
  });

  const observe = () => {
    try {
      return input.reconcile();
    } catch (error) {
      return { state: 'unknown' as const, reason: (error as Error).message };
    }
  };
  const before = observe();
  if (before.state === 'applied') {
    input.store.completeSideEffect(input.idempotencyKey, { outcome: 'reconciled', observed: before.result });
    return { value: before.result, reconciled: true };
  }
  if (before.state === 'unknown') {
    input.store.markSideEffectUncertain(input.idempotencyKey, before.reason);
    throw new Error(`Cannot safely reconcile ${input.kind}: ${before.reason}`);
  }

  let response: T;
  try {
    response = input.apply();
  } catch (error) {
    const afterFailure = observe();
    if (afterFailure.state === 'applied') {
      input.store.completeSideEffect(input.idempotencyKey, { outcome: 'reconciled-after-error', observed: afterFailure.result });
      return { value: afterFailure.result, reconciled: true };
    }
    if (afterFailure.state === 'unknown') input.store.markSideEffectUncertain(input.idempotencyKey, afterFailure.reason);
    throw error;
  }

  const after = observe();
  if (after.state === 'applied') {
    input.store.completeSideEffect(input.idempotencyKey, {
      outcome: 'applied',
      observed: after.result,
      response: response ?? null,
    });
    return { value: response, reconciled: false };
  }
  const reason = after.state === 'unknown'
    ? after.reason
    : `provider returned successfully but ${input.kind} is still absent`;
  input.store.markSideEffectUncertain(input.idempotencyKey, reason);
  throw new Error(`Could not verify ${input.kind} after the external write: ${reason}`);
}
