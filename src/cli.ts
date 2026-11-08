#!/usr/bin/env node
import { COMMANDS, HELP, CliError, parseArgs, reconcilePendingSideEffects } from './core/commands.js';
import { withMutationGuard } from './core/config.js';
import { VERSION } from './version.js';

const GUARDED = new Set([
  'run', 'dod',
  'claim', 'resume-lock', 'checkpoint', 'release', 'label', 'comment',
  'change-create', 'merge', 'evidence', 'ensure-labels',
]);

const [command = 'help', ...rest] = process.argv.slice(2);

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

  // run --dry-run is deliberately outside the guard and does not reconcile or
  // open SQLite. The dod command stays guarded for its complete execution.
  if (command === 'run' && opts['dry-run']) return await handler(opts) ?? 0;
  if (command === 'doctor' || command === 'jobs') return await handler(opts) ?? 0;
  if (GUARDED.has(command)) {
    return await withMutationGuard(async () => {
      opts.reconciliation = reconcilePendingSideEffects(opts);
      return await handler(opts) ?? 0;
    });
  }
  opts.reconciliation = withMutationGuard(() => reconcilePendingSideEffects(opts));
  return await handler(opts) ?? 0;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  console.error((error as Error).message);
  process.exitCode = (error as { exitCode?: number }).exitCode ?? 1;
});
