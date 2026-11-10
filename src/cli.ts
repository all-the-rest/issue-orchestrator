#!/usr/bin/env node
import { COMMANDS, HELP, CliError, parseArgs, reconcilePendingSideEffects, requestRunShutdown } from './core/commands.js';
import { withMutationGuard } from './core/config.js';
import { VERSION } from './version.js';

const GUARDED = new Set([
  'dod',
  'claim', 'resume-lock', 'checkpoint', 'release', 'label', 'comment',
  'change-create', 'merge', 'evidence', 'ensure-labels',
  'project',
]);

const [command = 'help', ...rest] = process.argv.slice(2);
let pendingSignal: NodeJS.Signals | null = null;
if (command === 'run' || command === 'goal') {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      pendingSignal = signal;
      void requestRunShutdown(signal).catch((error) => {
        console.error(`Unable to safely stop the active agent: ${(error as Error).message}`);
        process.exitCode = signal === 'SIGINT' ? 130 : 143;
      });
    });
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(rest);
  if (opts['no-switch']) {
    throw new CliError('--no-switch was removed; the configured active CLI account is always verified');
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) throw new CliError(`Unknown command "${command}"\n\n${HELP}`);

  // Printing service templates is intentionally config/state-free.
  if (command === 'service') return await handler(opts) ?? 0;

  // run --dry-run is deliberately outside the guard and does not reconcile or
  // open SQLite. The dod command stays guarded for its complete execution.
  if (command === 'run' && opts['dry-run']) return await handler(opts) ?? 0;
  if (command === 'run') {
    // Reconciliation remains globally serialized, but never hold the global
    // mutation guard for the lifetime of an agent workflow.
    opts.reconciliation = withMutationGuard(() => reconcilePendingSideEffects(opts));
    return await handler(opts) ?? 0;
  }
  if (command === 'goal') {
    // Serialize startup reconciliation, but do not hold the global guard while
    // the selected agent works on the ticket.
    opts.reconciliation = withMutationGuard(() => reconcilePendingSideEffects(opts));
    return await handler(opts) ?? 0;
  }
  if (command === 'doctor' || command === 'jobs' || command === 'logs') {
    if (command === 'jobs' && ['retry', 'cancel'].includes(opts._[0])) return await withMutationGuard(() => handler(opts)) ?? 0;
    return await handler(opts) ?? 0;
  }
  if (GUARDED.has(command)) {
    return await withMutationGuard(async () => {
      if (command !== 'project') opts.reconciliation = reconcilePendingSideEffects(opts);
      return await handler(opts) ?? 0;
    });
  }
  opts.reconciliation = withMutationGuard(() => reconcilePendingSideEffects(opts));
  return await handler(opts) ?? 0;
}

main().then((exitCode) => {
  process.exitCode = pendingSignal ? (pendingSignal === 'SIGINT' ? 130 : 143) : exitCode;
}).catch((error) => {
  console.error((error as Error).message);
  process.exitCode = (error as { exitCode?: number }).exitCode ?? 1;
});
