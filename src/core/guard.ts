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

function createGuard(guardFile: string): void {
  const fd = fs.openSync(guardFile, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Replace a dead holder's guard, serialized by `<guard>.reclaim`.
 *
 * Without that second lock two processes can both observe the same dead pid,
 * and the slower one can unlink the guard the faster one has just created —
 * both then enter the critical section. Here only the owner of the reclaim
 * lock may unlink and re-create the guard, and it does both inside the lock.
 *
 * The reclaim lock is deliberately never age-reclaimed: it is held for a few
 * syscalls, and if a process dies there the error names the file so an
 * operator can remove it after checking that no run is active.
 *
 * Returns true when this call replaced the guard (or created it after the
 * holder vanished) and the caller may enter.
 */
function takeOverStale(guardFile: string): boolean {
  const reclaimFile = `${guardFile}.reclaim`;
  let reclaimFd: number;
  try {
    reclaimFd = fs.openSync(reclaimFile, 'wx', 0o600);
  } catch {
    return false; // another process is reclaiming; treat it as busy
  }
  try {
    let age = 0;
    let exists = true;
    try {
      age = Date.now() - fs.statSync(guardFile).mtimeMs;
    } catch {
      exists = false;
    }
    if (exists) {
      const state = holderState(guardFile);
      if (!(state === 'dead' || (state === 'unknown' && age > STALE_MS))) return false;
      fs.unlinkSync(guardFile);
    }
    createGuard(guardFile);
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(reclaimFd);
    try {
      fs.unlinkSync(reclaimFile);
    } catch {
      // already gone; nothing to release
    }
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

  for (;;) {
    try {
      createGuard(guardFile);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (takeOverStale(guardFile)) break;
      throw new Error(
        `another queue mutation is in progress (${guardFile}); retry when it finishes, ` +
        `or remove ${guardFile} and ${guardFile}.reclaim if no run is active`,
      );
    }
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
