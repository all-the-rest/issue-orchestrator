#!/usr/bin/env node
import { COMMANDS, HELP, CliError, parseArgs } from './core/commands.js';
import { configPath, lockPath } from './core/config.js';
import { withMutationGuard } from './core/guard.js';
import { VERSION } from './version.js';

// Commands that read-modify-write the queue lock or the tracker. They are
// serialized across processes; read-only commands run unguarded.
const GUARDED = new Set([
  'claim', 'resume-lock', 'checkpoint', 'release', 'label', 'comment',
  'change-create', 'merge', 'evidence', 'ensure-labels',
]);

const [command = 'help', ...rest] = process.argv.slice(2);

function main(): number {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }

  const opts = parseArgs(rest);
  if (opts['no-switch']) {
    throw new CliError('--no-switch was removed; the configured active CLI account is always verified');
  }

  const handler = COMMANDS[command];
  if (!handler) throw new CliError(`Unknown command "${command}"\n\n${HELP}`);

  const invoke = () => handler(opts) ?? 0;
  if (!GUARDED.has(command)) return invoke();
  return withMutationGuard(lockPath(opts.config ?? configPath()), invoke);
}

let exitCode = 0;
try {
  exitCode = main();
} catch (error) {
  console.error((error as Error).message);
  exitCode = (error as { exitCode?: number }).exitCode ?? 1;
}

process.exitCode = exitCode;
