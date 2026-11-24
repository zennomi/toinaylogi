import { randomUUID } from 'node:crypto';
import { type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const isContention = (error: unknown) =>
  ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(errorCode(error) ?? '');

// A transient release error must not strand this live process's lock forever.
// Retry only releases that were explicitly requested, never an active owner.
const pendingReleases = new Map<string, () => Promise<void>>();

type Owner = {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  startedAt: number;
};

const ownerFileName = (token: string) => `owner-${token}.json`;

export function refreshLockOwnerFile(names: string[]): string | null {
  return names.length === 1 && /^owner-[a-f0-9-]{36}\.json$/.test(names[0])
    ? names[0]
    : null;
}

async function removeOwner(lockPath: string, name: string, identity: Stats) {
  const ownerPath = join(lockPath, name);
  try {
    const current = await lstat(ownerPath);
    if (current.dev !== identity.dev || current.ino !== identity.ino) return;
    await unlink(ownerPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  try {
    // Never recursively remove the shared path. A successor is published as
    // a NONEMPTY directory in one rename, so even a delayed rmdir cannot erase it.
    await rmdir(lockPath);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? ''))
      throw error;
  }
}

async function reclaimDeadOwner(lockPath: string) {
  try {
    // Old-format files, symlinks and incomplete/foreign records need manual
    // recovery: neither elapsed time nor an unreadable PID proves owner death.
    if (!(await lstat(lockPath)).isDirectory()) return false;
    const names = await readdir(lockPath);
    if (!names.length) return true;
    const name = refreshLockOwnerFile(names);
    if (!name) return false;
    const ownerPath = join(lockPath, name);
    const identity = await lstat(ownerPath);
    if (!identity.isFile() || identity.size > 1024) return false;
    const owner: Owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (
      !owner ||
      owner.version !== 1 ||
      name !== ownerFileName(owner.token) ||
      owner.hostname !== hostname() ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      !Number.isSafeInteger(owner.startedAt) ||
      owner.startedAt < 1
    )
      return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      // EPERM, PID reuse, other hosts and unknown failures are all treated as
      // live. Recovery is only safe for a demonstrably absent local PID.
      if (errorCode(error) !== 'ESRCH') return false;
    }
    await removeOwner(lockPath, name, identity);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

export async function retryPendingRefreshLockRelease(lockPath: string) {
  await pendingReleases.get(lockPath)?.();
}

export async function acquireRefreshLock(lockPath: string) {
  await retryPendingRefreshLockRelease(lockPath);
  await mkdir(dirname(lockPath), { recursive: true });
  const candidate = await mkdtemp(join(dirname(lockPath), '.refresh-lock-'));
  const owner: Owner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    startedAt: Date.now(),
  };
  const name = ownerFileName(owner.token);
  let published = false;
  try {
    await writeFile(join(candidate, name), JSON.stringify(owner), {
      encoding: 'utf8',
      flag: 'wx',
    });
    const identity = await lstat(join(candidate, name));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // POSIX rename cannot replace a nonempty directory. Preparing the
        // record before publishing also eliminates a crash/empty-owner window.
        await rename(candidate, lockPath);
        published = true;
        const release = async () => {
          try {
            await removeOwner(lockPath, name, identity);
            if (pendingReleases.get(lockPath) === release)
              pendingReleases.delete(lockPath);
          } catch (error) {
            pendingReleases.set(lockPath, release);
            throw error;
          }
        };
        return release;
      } catch (error) {
        if (!isContention(error)) throw error;
        if (attempt || !(await reclaimDeadOwner(lockPath))) return null;
      }
    }
    return null;
  } finally {
    if (!published) await rm(candidate, { recursive: true, force: true });
  }
}
