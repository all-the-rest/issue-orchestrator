import fs from 'node:fs';
import path from 'node:path';

const STALE_MS = 5 * 60 * 1000;

type HolderState = 'alive' | 'dead' | 'unknown';

/** Whether the process that wrote the guard file still exists. */
function holderState(guardFile: string): HolderState {
  let pid: unknown;
  try {
    pid = JSON.parse(fs.readFileSync(guardFile, 'utf8')).pid;
  } catch {
    return 'unknown';
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  if (pid === process.pid) return 'alive';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'dead';
  }
}

/**
 * Serialize mutations across processes without `flock`.
 *
 * The guard is an exclusive-create file next to the queue lock. `O_EXCL`
 * gives one winner. The file records the holder's pid, so a crashed holder
 * is reclaimed immediately; an unreadable guard falls back to a five-minute
 * age. A live holder is never evicted, however long its subprocess takes.
 * SQLite transactions replace this in the persistence issue.
 */
export function withMutationGuard<T>(lockFile: string, fn: () => T): T {
  const guardFile = `${lockFile}.guard`;
  fs.mkdirSync(path.dirname(guardFile), { recursive: true, mode: 0o700 });

  let fd: number;
  for (;;) {
    try {
      fd = fs.openSync(guardFile, 'wx', 0o600);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      let age = 0;
      try {
        age = Date.now() - fs.statSync(guardFile).mtimeMs;
      } catch {
        continue; // the holder released it between open and stat
      }

      const state = holderState(guardFile);
      if (state === 'dead' || (state === 'unknown' && age > STALE_MS)) {
        try {
          fs.unlinkSync(guardFile);
        } catch {
          // another process won the cleanup race; loop and try again
        }
        continue;
      }
      throw new Error(
        `another queue mutation is in progress (guard ${guardFile}); retry after it finishes`,
      );
    }
  }

  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(guardFile);
    } catch {
      // already gone; nothing to release
    }
  }
}
