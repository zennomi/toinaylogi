import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActressCacheHandler } from '../scripts/serve-actress-cache.mjs';
import { parseServerOptions } from '../scripts/serve.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'toinay-cache-'));
  const root = join(directory, 'cache');
  const handler = createActressCacheHandler(root);
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) res.writeHead(418).end('Next fallback');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = (path, method = 'GET') =>
    new Promise((resolve, reject) => {
      const req = request(base, { path, method }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  return { directory, root, base, raw };
}

test('serves JSON and images created after server startup, including an empty initial cache', async (t) => {
  const { root, base } = await fixture(t);
  const snapshotPath = '/actress-cache/snapshots/new-snapshot/snapshot.json';
  let response = await fetch(base + snapshotPath);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await response.text();
  await mkdir(join(root, 'snapshots/new-snapshot/images'), { recursive: true });
  await writeFile(
    join(root, 'snapshots/new-snapshot/snapshot.json'),
    '{"rating":8}',
  );
  await writeFile(
    join(root, 'snapshots/new-snapshot/images/demo.png'),
    Buffer.from([137, 80, 78, 71]),
  );
  response = await fetch(base + snapshotPath);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-type'),
    'application/json; charset=utf-8',
  );
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.deepEqual(await response.json(), { rating: 8 });
  const image = await fetch(
    base + '/actress-cache/snapshots/new-snapshot/images/demo.png',
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal((await image.arrayBuffer()).byteLength, 4);
});

test('ETags detect same-ID and same-size edits; manifests and status are never cached', async (t) => {
  const { root, base } = await fixture(t);
  await mkdir(join(root, 'snapshots/demo'), { recursive: true });
  const path = '/actress-cache/snapshots/demo/snapshot.json';
  const file = join(root, 'snapshots/demo/snapshot.json');
  await writeFile(file, '{"rating":8}');
  const first = await fetch(base + path);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  await first.text();
  const unchanged = await fetch(base + path, {
    headers: { 'If-None-Match': `W/${etag}` },
  });
  assert.equal(unchanged.status, 304);
  await writeFile(file, '{"rating":9}');
  const changed = await fetch(base + path, {
    headers: { 'If-None-Match': etag },
  });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.deepEqual(await changed.json(), { rating: 9 });
  const head = await fetch(base + path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '12');
  assert.equal(await head.text(), '');
  for (const name of ['current.json', 'status.json']) {
    await writeFile(join(root, name), '{}');
    const response = await fetch(base + '/actress-cache/' + name, {
      headers: { 'If-None-Match': '*' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await response.text();
  }
});

test('cache serving rejects traversal, private files, outside symlinks and write methods', async (t) => {
  const { root, directory, raw } = await fixture(t);
  await mkdir(join(root, 'snapshots/demo'), { recursive: true });
  await writeFile(join(directory, 'secret.json'), 'secret');
  await symlink(
    join(directory, 'secret.json'),
    join(root, 'snapshots/demo/snapshot.json'),
  );
  for (const path of [
    '/other/../actress-cache/current.json',
    '/other/%2e%2e/actress-cache/current.json',
    '/other/../actress-cache/snapshots/demo/snapshot.json',
    '/other//..//actress-cache/refresh.lock',
    '/other/%2f..%2factress-cache/refresh.lock',
    '/actress-cache',
    '/actress-cache/',
    '/actress-cache/../secret.json',
    '/actress-cache/%2e%2e/secret.json',
    '/actress-cache/snapshots/demo/../../secret.json',
    '/actress%2dcache/snapshots/demo/snapshot.json',
    '/actress-cache%2frefresh.lock',
    '/actress-cache/snapshots/demo/snapshot.json',
    '/actress-cache/refresh.lock',
    '/actress-cache/.staging/demo/snapshot.json',
    '/actress-cache/current.json%00',
    '/actress-cache/snapshots/demo/images/..%5csecret.json',
  ]) {
    const response = await raw(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.body.includes('secret'), false);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const post = await raw('/actress-cache/current.json', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal((await raw('/')).status, 418);
});

test('cache serving bounds file size and rejects directories', async (t) => {
  const { root, raw } = await fixture(t);
  await mkdir(root);
  await mkdir(join(root, 'current.json'));
  assert.equal((await raw('/actress-cache/current.json')).status, 404);
  const file = await open(join(root, 'status.json'), 'w');
  await file.truncate(8 * 1024 * 1024 + 1);
  await file.close();
  assert.equal((await raw('/actress-cache/status.json')).status, 404);
});

test('production entry defaults to loopback and accepts existing port/hostname flags', () => {
  assert.deepEqual(parseServerOptions([], {}), {
    port: 3000,
    hostname: '127.0.0.1',
    help: false,
  });
  assert.equal(
    parseServerOptions([], { PORT: '6001', HOSTNAME: 'external' }).hostname,
    '127.0.0.1',
  );
  assert.equal(parseServerOptions([], { PORT: '6001' }).port, 6001);
  assert.deepEqual(
    parseServerOptions(['--port', '6001', '--hostname', '127.0.0.1'], {}),
    { port: 6001, hostname: '127.0.0.1', help: false },
  );
  for (const port of ['-1', '65536', 'abc', '3.5', '']) {
    assert.throws(() => parseServerOptions(['--port', port], {}));
  }
  assert.throws(() => parseServerOptions(['--unexpected'], {}));
});
