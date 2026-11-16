import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { acquireRefreshLock } from '../src/server/jav-crawler/refresh-lock';

let root: string;
let lock: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'refresh-lock-test-'));
  lock = join(root, 'refresh.lock');
});
afterEach(async (t) => {
  t.mock.restoreAll();
  syncBuiltinESMExports();
  await fs.rm(root, { recursive: true, force: true });
});

const errno = (code: string) => Object.assign(new Error(code), { code });
async function ownerFile() {
  const names = await fs.readdir(lock);
  assert.equal(names.length, 1);
  return join(lock, names[0]);
}

async function crashOwner(t: TestContext) {
  const source = new URL(
    '../src/server/jav-crawler/refresh-lock.ts',
    import.meta.url,
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    const { acquireRefreshLock } = await import(${JSON.stringify(source.href)});
    const release = await acquireRefreshLock(${JSON.stringify(lock)});
    process.send(Boolean(release));
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  t.after(() => child.kill('SIGKILL'));
  const [acquired] = await once(child, 'message');
  assert.equal(acquired, true);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('competing acquisitions have one owner; live locks never expire after an hour', async () => {
  const releases = await Promise.all(
    Array.from({ length: 12 }, () => acquireRefreshLock(lock)),
  );
  const winners = releases.filter((release) => release !== null);
  assert.equal(winners.length, 1);
  const owner = await ownerFile();
  const record = JSON.parse(await fs.readFile(owner, 'utf8'));
  record.startedAt -= 2 * 60 * 60 * 1000;
  await fs.writeFile(owner, JSON.stringify(record));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(owner, old, old);
  await fs.utimes(lock, old, old);
  assert.equal(await acquireRefreshLock(lock), null);
  await winners[0]();
  const next = await acquireRefreshLock(lock);
  assert.ok(next);
  await next();
  assert.deepEqual(await fs.readdir(root), []);
});

test('crashed process is recovered safely by competing reclaimers', async (t) => {
  await crashOwner(t);
  const releases = await Promise.all(
    Array.from({ length: 16 }, () => acquireRefreshLock(lock)),
  );
  const winners = releases.filter((release) => release !== null);
  assert.equal(winners.length, 1);
  assert.equal(await acquireRefreshLock(lock), null);
  await winners[0]();
});

test('delayed old release and empty-directory cleanup cannot delete a successor', async (t) => {
  const release = await acquireRefreshLock(lock);
  assert.ok(release);
  const rmdir = fs.rmdir;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  t.mock.method(fs, 'rmdir', async (...args: Parameters<typeof fs.rmdir>) => {
    if (args[0] === lock) {
      enter();
      await paused;
    }
    return rmdir(...args);
  });
  syncBuiltinESMExports();
  const releasing = release();
  await entered;
  const successor = await acquireRefreshLock(lock);
  assert.ok(successor);
  const successorOwner = await ownerFile();
  resume();
  await releasing;
  await release();
  assert.equal(await ownerFile(), successorOwner);
  assert.equal(await acquireRefreshLock(lock), null);
  await successor();
});

test('stale reclaim rmdir cannot delete a newly published owner', async (t) => {
  await crashOwner(t);
  const rmdir = fs.rmdir;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  t.mock.method(fs, 'rmdir', async (...args: Parameters<typeof fs.rmdir>) => {
    if (args[0] === lock) {
      enter();
      await paused;
    }
    return rmdir(...args);
  });
  syncBuiltinESMExports();
  const reclaiming = acquireRefreshLock(lock);
  await entered;
  const winner = await acquireRefreshLock(lock);
  assert.ok(winner);
  resume();
  assert.equal(await reclaiming, null);
  assert.equal(await acquireRefreshLock(lock), null);
  await winner();
});

test('uncertain PID, foreign, malformed and legacy owners are not stolen', async (t) => {
  const release = await acquireRefreshLock(lock);
  assert.ok(release);
  const owner = await ownerFile();
  const record = JSON.parse(await fs.readFile(owner, 'utf8'));
  for (const code of ['EPERM', 'EACCES', 'EINVAL']) {
    const probe = t.mock.method(process, 'kill', () => {
      throw errno(code);
    });
    assert.equal(await acquireRefreshLock(lock), null);
    probe.mock.restore();
  }
  for (const body of [
    { ...record, hostname: 'another-machine' },
    { ...record, pid: 0 },
    { ...record, pid: -1 },
    { ...record, pid: 1.5 },
    { ...record, token: 'wrong-owner' },
    null,
  ]) {
    await fs.writeFile(owner, JSON.stringify(body));
    assert.equal(await acquireRefreshLock(lock), null);
  }
  await fs.writeFile(owner, '{broken');
  assert.equal(await acquireRefreshLock(lock), null);
  await release();
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: 1 }));
  assert.equal(await acquireRefreshLock(lock), null);
});

test('failed owner preparation never publishes a partial lock; subsequent attempts work', async (t) => {
  const writeFile = fs.writeFile;
  const failure = t.mock.method(
    fs,
    'writeFile',
    async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).includes('.refresh-lock-')) throw errno('EIO');
      return writeFile(...args);
    },
  );
  syncBuiltinESMExports();
  await assert.rejects(acquireRefreshLock(lock), { code: 'EIO' });
  assert.deepEqual(await fs.readdir(root), []);
  failure.mock.restore();
  syncBuiltinESMExports();
  const release = await acquireRefreshLock(lock);
  assert.ok(release);
  await release();
});

test('failed release retains ownership and is retryable without deleting successors', async (t) => {
  const release = await acquireRefreshLock(lock);
  assert.ok(release);
  const failure = t.mock.method(fs, 'unlink', async () => {
    throw errno('EACCES');
  });
  syncBuiltinESMExports();
  await assert.rejects(release(), { code: 'EACCES' });
  await assert.rejects(acquireRefreshLock(lock), { code: 'EACCES' });
  await ownerFile();
  failure.mock.restore();
  syncBuiltinESMExports();
  // Acquisition itself retries the failed release, even if its caller discarded
  // the callback after logging the failure.
  const successor = await acquireRefreshLock(lock);
  assert.ok(successor);
  await release();
  assert.equal(await acquireRefreshLock(lock), null);
  await successor();
});
