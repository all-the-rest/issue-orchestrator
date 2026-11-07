#!/usr/bin/env node
import { COMMANDS, HELP, CliError, parseArgs } from './core/commands.js';
import { withMutationGuard } from './core/config.js';
import { VERSION } from './version.js';

const GUARDED = new Set([
  'claim', 'resume-lock', 'checkpoint', 'release', 'label', 'comment',
  'change-create', 'merge', 'evidence', 'ensure-labels',
]);

const [command = 'help', ...rest] = process.argv.slice(2);

function main(): number {
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

  const invoke = () => handler(opts) ?? 0;
  return GUARDED.has(command) ? withMutationGuard(invoke) : invoke();
}

let exitCode = 0;
try {
  exitCode = main();
} catch (error) {
  console.error((error as Error).message);
  exitCode = (error as { exitCode?: number }).exitCode ?? 1;
}

process.exitCode = exitCode;
