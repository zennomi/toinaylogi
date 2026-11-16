import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, afterEach, beforeEach } from 'node:test';
import timers from 'node:timers/promises';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type ActressSnapshot,
} from '../src/lib/actresses';
import { assignFoodAliases, createSeededRandom } from '../src/lib/food-aliases';

// These modules capture cwd on import. Import only after entering the isolated
// temporary root; no test can read or write the application's real cache.
const projectRoot = process.cwd();
const root = await fs.mkdtemp(join(tmpdir(), 'refresh-store-test-'));
process.chdir(root);
const store = await import('../src/server/jav-crawler/store');
const { refreshActressData } =
  await import('../src/server/jav-crawler/crawler');
const { createActressRefreshScheduler } =
  await import('../src/server/jav-crawler/scheduler');
const rankingHtml = await fs.readFile(
  new URL('./fixtures/xxx-guru.html', import.meta.url),
  'utf8',
);

beforeEach(async (t) => {
  await fs.rm(store.paths.publicRoot, { recursive: true, force: true });
  await fs.rm(store.paths.workRoot, { recursive: true, force: true });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network request');
  });
  t.mock.method(timers, 'setTimeout', async () => undefined);
  syncBuiltinESMExports();
});
afterEach((t) => {
  t.mock.restoreAll();
  syncBuiltinESMExports();
});
after(async () => {
  process.chdir(projectRoot);
  await fs.rm(root, { recursive: true, force: true });
});

const errno = (code: string) => Object.assign(new Error(code), { code });
const manifest = (createdAt = new Date().toISOString()) => ({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  snapshotId: 'demo',
  snapshotPath: '/actress-cache/snapshots/demo/snapshot.json',
  createdAt,
});
const json = async (path: string) =>
  JSON.parse(await fs.readFile(path, 'utf8'));
const response = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/html' } });

function snapshot(snapshotId = 'demo'): ActressSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    createdAt: new Date().toISOString(),
    source: {
      url: 'https://jav.guru/?s=&orderby=views-monthly&order=DESC&category_name=jav',
      orderBy: 'views-monthly',
      category: 'jav',
      pages: 3,
      listEntries: 45,
      uniqueMovies: 15,
      enrichment: {
        provider: 'avbase',
        attempted: 0,
        matched: 0,
        skipped: 0,
        blocked: 0,
      },
    },
    actresses: assignFoodAliases(
      [
        {
          id: 'demo',
          sourceUrl: 'https://jav.guru/actress/demo/',
          name: 'Demo',
          publicName: '',
          aliases: [],
          socialLinks: [],
          imagePath: `/actress-cache/snapshots/${snapshotId}/images/demo.jpg`,
          score: 1,
          tier: 0,
          bestRank: 1,
          appearances: 1,
          contributingMovies: [
            { rank: 1, code: 'DEMO-1', movieUrl: 'https://jav.guru/demo/' },
          ],
        },
      ],
      createSeededRandom('runtime-test'),
    ),
  };
}

async function stage(data: ActressSnapshot) {
  const staging = await store.makeStaging(data.snapshotId);
  await fs.writeFile(join(staging, 'snapshot.json'), JSON.stringify(data));
  await fs.writeFile(join(staging, 'images', 'demo.jpg'), 'synthetic image');
  return staging;
}

test('malformed manifests, mismatched paths and invalid/future timestamps cannot suppress refresh', async () => {
  await store.ensureRoots();
  assert.equal(await store.isDue(), true);
  for (const body of [
    null,
    {},
    { ...manifest(), schemaVersion: 999 },
    {
      ...manifest(),
      snapshotPath: '/actress-cache/snapshots/other/snapshot.json',
    },
    { ...manifest(), snapshotId: '../escape' },
    { ...manifest(), snapshotPath: 'https://example.com/snapshot.json' },
    manifest('not-a-date'),
    manifest('2026-02-30T00:00:00.000Z'),
    manifest('9999-01-01T00:00:00.000Z'),
    manifest(''),
  ]) {
    await fs.writeFile(
      join(store.paths.publicRoot, 'current.json'),
      JSON.stringify(body),
    );
    assert.equal(await store.currentSnapshot(), null, JSON.stringify(body));
    assert.equal(await store.isDue(), true);
  }
  await fs.writeFile(join(store.paths.publicRoot, 'current.json'), '{broken');
  assert.equal(await store.isDue(), true);
  const fresh = manifest();
  await fs.writeFile(
    join(store.paths.publicRoot, 'current.json'),
    JSON.stringify(fresh),
  );
  assert.deepEqual(await store.currentSnapshot(), fresh);
  assert.equal(await store.isDue(), false);
  await fs.writeFile(
    join(store.paths.publicRoot, 'current.json'),
    JSON.stringify(
      manifest(new Date(Date.now() - 8 * 86400_000).toISOString()),
    ),
  );
  assert.equal(await store.isDue(), true);
});

test('publishing and status writes keep staging and unique temps on the destination filesystem', async (t) => {
  const rename = fs.rename;
  const moves: [string, string][] = [];
  t.mock.method(fs, 'rename', async (from: string, to: string) => {
    moves.push([from, to]);
    // Model .cache and public living on different mounted filesystems.
    if (
      from.startsWith(store.paths.workRoot) &&
      to.startsWith(store.paths.publicRoot)
    )
      throw errno('EXDEV');
    assert.equal(dirname(from), dirname(to));
    return rename(from, to);
  });
  syncBuiltinESMExports();
  const data = snapshot();
  const staging = await stage(data);
  assert.equal(dirname(staging), store.paths.snapshotsRoot);
  await store.publishSnapshot(data, staging);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.writeStatus({ state: 'idle', message: String(i) }),
    ),
  );
  assert.equal(moves.length, 11);
  assert.equal(new Set(moves.map(([from]) => from)).size, moves.length);
  assert.deepEqual(await store.currentSnapshot(), manifest(data.createdAt));
  assert.deepEqual(
    await json(join(store.paths.snapshotsRoot, 'demo', 'snapshot.json')),
    data,
  );
  assert.equal(
    (await json(join(store.paths.publicRoot, 'status.json'))).state,
    'idle',
  );
  assert.deepEqual((await fs.readdir(store.paths.publicRoot)).sort(), [
    'current.json',
    'snapshots',
    'status.json',
  ]);
  assert.deepEqual(await fs.readdir(store.paths.workRoot), []);
});

test('failed manifest publication keeps the old generation usable and removes temp files', async (t) => {
  const old = snapshot('old');
  await store.publishSnapshot(old, await stage(old));
  const previous = await store.currentSnapshot();
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from: string, to: string) => {
    if (to === join(store.paths.publicRoot, 'current.json')) throw errno('EIO');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  const next = snapshot('next');
  await assert.rejects(store.publishSnapshot(next, await stage(next)), {
    code: 'EIO',
  });
  assert.deepEqual(await store.currentSnapshot(), previous);
  assert.deepEqual(
    await json(join(store.paths.snapshotsRoot, 'old', 'snapshot.json')),
    old,
  );
  assert.equal(
    (await fs.readdir(store.paths.publicRoot)).some((name) =>
      name.endsWith('.tmp'),
    ),
    false,
  );
});

test('invalid publish metadata and duplicate generations never remove the current snapshot', async () => {
  const data = snapshot();
  await store.publishSnapshot(data, await stage(data));
  const staging = await stage(data);
  await assert.rejects(
    store.publishSnapshot({ ...data, createdAt: 'bad-time' }, staging),
    /invalid manifest/,
  );
  await assert.rejects(
    store.publishSnapshot({ ...data, snapshotId: '../escape' }, staging),
    /invalid manifest/,
  );
  await assert.rejects(store.publishSnapshot(data, staging));
  assert.deepEqual(
    await json(join(store.paths.snapshotsRoot, 'demo', 'snapshot.json')),
    data,
  );
  assert.equal(await store.isDue(), false);
  await assert.rejects(store.makeStaging('../escape'), /Invalid snapshot ID/);
});

test('scheduler schedules and unrefs the next attempt after due-check and refresh rejection', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const pending: { run: () => void; delay?: number }[] = [];
  let unrefs = 0;
  let checks = 0;
  let refreshes = 0;
  const start = createActressRefreshScheduler({
    async checkDue() {
      checks++;
      if (checks === 1) throw new Error('due check failed');
      return checks !== 5;
    },
    async refresh() {
      refreshes++;
      if (refreshes === 1) throw new Error('acquisition or cleanup failed');
      return refreshes !== 2;
    },
    later: ((run: () => void, delay?: number) => {
      pending.push({ run, delay });
      return {
        unref() {
          unrefs++;
        },
      };
    }) as typeof setTimeout,
  });
  start();
  start();
  for (const expected of [
    900_000, 900_000, 900_000, 604800_000, 3600_000, 604800_000,
  ]) {
    await timers.setImmediate();
    assert.equal(pending.length, 1);
    const next = pending.shift()!;
    assert.equal(next.delay, expected);
    if (checks < 6) next.run();
  }
  assert.equal(checks, 6);
  assert.equal(refreshes, 4);
  assert.equal(unrefs, 6);
  assert.equal(errors.mock.callCount(), 2);
});

test('scheduler retries a failed release even after a successful publication makes data fresh', async (t) => {
  t.mock.method(console, 'error', () => {});
  const data = snapshot();
  await store.publishSnapshot(data, await stage(data));
  const release = await store.takeLock();
  assert.ok(release);
  const failure = t.mock.method(fs, 'unlink', async () => {
    throw errno('EACCES');
  });
  syncBuiltinESMExports();
  await assert.rejects(release(), { code: 'EACCES' });
  const pending: { run: () => void; delay?: number }[] = [];
  let scheduled!: () => void;
  const firstTick = new Promise<void>((resolve) => {
    scheduled = resolve;
  });
  let refreshes = 0;
  createActressRefreshScheduler({
    async refresh() {
      refreshes++;
      return true;
    },
    later: ((run: () => void, delay?: number) => {
      pending.push({ run, delay });
      scheduled();
      return { unref() {} };
    }) as typeof setTimeout,
  })();
  await firstTick;
  // The failed release is recoverable and must not stop scheduling.
  assert.equal(pending[0]?.delay, 900_000);
  failure.mock.restore();
  syncBuiltinESMExports();
  const secondTick = new Promise<void>((resolve) => {
    scheduled = resolve;
  });
  pending.shift()!.run();
  await secondTick;
  assert.equal(pending[0]?.delay, 3600_000);
  assert.equal(
    refreshes,
    0,
    'fresh data must not trigger another crawl just to release a lock',
  );
  await assert.rejects(fs.lstat(store.paths.lockPath), { code: 'ENOENT' });
});

test('crawler returns failure on lock acquisition errors and the next attempt can acquire', async (t) => {
  t.mock.method(console, 'error', () => {});
  const mkdir = fs.mkdir;
  const failure = t.mock.method(
    fs,
    'mkdir',
    async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[0] === store.paths.workRoot) throw errno('EACCES');
      return mkdir(...args);
    },
  );
  syncBuiltinESMExports();
  assert.equal(await refreshActressData(), false);
  failure.mock.restore();
  syncBuiltinESMExports();
  const release = await store.takeLock();
  assert.ok(release);
  await release();
});

test('crawler drains failed profile workers before cleanup, attempts release even if cleanup fails, and retries failed release', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  let profileCalls = 0;
  let movieCalls = 0;
  let notify!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    notify = resolve;
  });
  let resume!: () => void;
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    assert.ok(
      url.startsWith('https://jav.guru/'),
      'enrichment/network must never run',
    );
    if (url.includes('orderby=')) return response(rankingHtml);
    if (url.includes('/actress/')) {
      profileCalls++;
      if (profileCalls === 2) {
        notify();
        await blocked;
      }
      return response('<html>broken profile</html>');
    }
    return response(
      `<div class="infoleft"><a href="/actress/star-${movieCalls++ % 3}/">Star</a></div>`,
    );
  });
  const rm = fs.rm;
  let cleanupAttempts = 0;
  const cleanupFailure = t.mock.method(
    fs,
    'rm',
    async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).includes('/.staging-')) {
        cleanupAttempts++;
        throw errno('EACCES');
      }
      return rm(...args);
    },
  );
  let releaseAttempts = 0;
  const releaseFailure = t.mock.method(fs, 'unlink', async () => {
    releaseAttempts++;
    throw errno('EACCES');
  });
  syncBuiltinESMExports();
  let settled = false;
  const refresh = refreshActressData().then((result) => {
    settled = true;
    return result;
  });
  await secondStarted;
  await timers.setImmediate();
  assert.equal(settled, false);
  assert.equal(profileCalls, 2);
  assert.equal(cleanupAttempts, 0);
  assert.equal(releaseAttempts, 0);
  assert.equal(await store.takeLock(), null);
  assert.equal((await fs.readdir(store.paths.snapshotsRoot)).length, 1);
  resume();
  assert.equal(await refresh, false);
  assert.equal(profileCalls, 2, 'third profile must not be assigned');
  assert.equal(cleanupAttempts, 1);
  assert.equal(releaseAttempts, 1);
  assert.equal(errors.mock.callCount(), 3);
  cleanupFailure.mock.restore();
  releaseFailure.mock.restore();
  syncBuiltinESMExports();
  const release = await store.takeLock();
  assert.ok(
    release,
    'a later attempt retries failed release instead of deadlocking',
  );
  await release();
});
