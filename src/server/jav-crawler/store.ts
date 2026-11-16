import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  SNAPSHOT_SCHEMA_VERSION,
  validateCurrent,
  validateSnapshot,
  type ActressSnapshot,
  type CurrentSnapshot,
  type RefreshStatus,
} from '@/lib/actresses';
import {
  acquireRefreshLock,
  retryPendingRefreshLockRelease,
} from './refresh-lock';

const publicRoot = join(process.cwd(), 'public', 'actress-cache');
const snapshotsRoot = join(publicRoot, 'snapshots');
const workRoot = join(process.cwd(), '.cache', 'jav-crawler');
const lockPath = join(workRoot, 'refresh.lock');
export const paths = { publicRoot, snapshotsRoot, workRoot, lockPath };

export async function ensureRoots() {
  await Promise.all([
    mkdir(snapshotsRoot, { recursive: true }),
    mkdir(workRoot, { recursive: true }),
  ]);
}
async function writePublicJson(name: string, body: unknown) {
  // Temp files must share the destination filesystem, not the private cache's.
  const temp = join(publicRoot, `.${name}-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(body), {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temp, join(publicRoot, name));
  } finally {
    await rm(temp, { force: true });
  }
}

function validManifest(input: unknown) {
  const current = validateCurrent(input);
  if (!current || !/^[a-z0-9-]{1,80}$/i.test(current.snapshotId)) return null;
  const timestamp = Date.parse(current.createdAt);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === current.createdAt &&
    timestamp <= Date.now() + 5 * 60 * 1000 &&
    current.snapshotPath ===
      `/actress-cache/snapshots/${current.snapshotId}/snapshot.json`
    ? current
    : null;
}

export async function writeStatus(
  status: Omit<RefreshStatus, 'schemaVersion' | 'updatedAt'>,
) {
  await ensureRoots();
  const body: RefreshStatus = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    ...status,
  };
  await writePublicJson('status.json', body);
}
export async function currentSnapshot(): Promise<CurrentSnapshot | null> {
  try {
    return validManifest(
      JSON.parse(await readFile(join(publicRoot, 'current.json'), 'utf8')),
    );
  } catch {
    return null;
  }
}
export async function isDue() {
  const current = await currentSnapshot();
  return (
    !current ||
    Date.now() - Date.parse(current.createdAt) >= 7 * 24 * 60 * 60 * 1000
  );
}
export async function retryPendingLockRelease() {
  await retryPendingRefreshLockRelease(lockPath);
}

export async function takeLock() {
  await ensureRoots();
  return acquireRefreshLock(lockPath);
}
export async function makeStaging(snapshotId: string) {
  if (!/^[a-z0-9-]{1,80}$/i.test(snapshotId))
    throw new Error('Invalid snapshot ID');
  await ensureRoots();
  const directory = await mkdtemp(
    join(snapshotsRoot, `.staging-${snapshotId}-`),
  );
  try {
    await mkdir(join(directory, 'images'));
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function publishSnapshot(
  snapshot: ActressSnapshot,
  staging: string,
) {
  if (!validateSnapshot(snapshot)) throw new Error('Refusing invalid snapshot');
  const manifest: CurrentSnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: snapshot.snapshotId,
    snapshotPath: `/actress-cache/snapshots/${snapshot.snapshotId}/snapshot.json`,
    createdAt: snapshot.createdAt,
  };
  if (!validManifest(manifest)) throw new Error('Refusing invalid manifest');
  const finalDirectory = join(snapshotsRoot, snapshot.snapshotId);
  // Published snapshots are immutable; never delete an existing generation.
  await rename(staging, finalDirectory);
  await writePublicJson('current.json', manifest);
  await writeStatus({ state: 'idle', message: 'Ready' });
}
