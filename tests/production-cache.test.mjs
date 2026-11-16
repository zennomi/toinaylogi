import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  copyFile,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const enabled = process.env.RUN_PRODUCTION_SMOKE === '1';

test(
  'production server serves a new snapshot and images without restart',
  { skip: !enabled, timeout: 45_000 },
  async (t) => {
    const repo = resolve(import.meta.dirname, '..');
    const directory = await mkdtemp(join(tmpdir(), 'toinay-production-'));
    const cache = join(directory, 'public/actress-cache');
    let child;
    let exited;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 12_000);
        force.unref();
        await exited;
        clearTimeout(force);
      }
      await rm(directory, { recursive: true, force: true });
    });
    await mkdir(cache, { recursive: true });
    await symlink(join(repo, '.next'), join(directory, '.next'), 'dir');
    await symlink(
      join(repo, 'node_modules'),
      join(directory, 'node_modules'),
      'dir',
    );
    await copyFile(
      join(repo, 'next.config.mjs'),
      join(directory, 'next.config.mjs'),
    );
    // No live crawler or Redis traffic is required. Keep the seed snapshot fresh
    // and prohibit accidental external fetches inside this isolated process.
    await writeFile(
      join(directory, 'no-network.mjs'),
      `
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        throw new Error('External network disabled in production smoke test');
      }
      return realFetch(input, init);
    };
  `,
    );

    async function publish(id, rating) {
      const snapshotPath = `/actress-cache/snapshots/${id}/snapshot.json`;
      const imagePath = `/actress-cache/snapshots/${id}/images/demo.png`;
      const createdAt = new Date().toISOString();
      await mkdir(join(cache, 'snapshots', id, 'images'), { recursive: true });
      await writeFile(
        join(cache, 'snapshots', id, 'images/demo.png'),
        Buffer.from([137, 80, 78, 71]),
      );
      const snapshot = {
        schemaVersion: 4,
        snapshotId: id,
        createdAt,
        source: {
          url: 'https://jav.guru/?s=&orderby=views-monthly&order=DESC&category_name=jav',
          orderBy: 'views-monthly',
          category: 'jav',
          pages: 3,
          listEntries: 45,
          uniqueMovies: 45,
          enrichment: {
            provider: 'avbase',
            attempted: 0,
            matched: 0,
            skipped: 0,
            blocked: 0,
          },
        },
        actresses: [
          {
            id: 'demo',
            name: 'Demo',
            publicName: 'Bánh mì',
            aliases: [],
            sourceUrl: 'https://jav.guru/actress/demo/',
            imagePath,
            socialLinks: [],
            ratings: { overall: rating },
            tags: ['美人'],
            debutYear: 2024,
            minnanoAvUrl: 'https://www.minnano-av.com/actress123.html',
            score: 45,
            tier: 0,
            bestRank: 1,
            appearances: 1,
            contributingMovies: [
              {
                rank: 1,
                code: 'DEMO-1',
                movieUrl: 'https://jav.guru/demo-movie/',
              },
            ],
          },
        ],
      };
      await writeFile(
        join(cache, 'snapshots', id, 'snapshot.json'),
        JSON.stringify(snapshot),
      );
      await writeFile(
        join(cache, 'current.tmp'),
        JSON.stringify({
          schemaVersion: 4,
          snapshotId: id,
          snapshotPath,
          createdAt,
        }),
      );
      await rename(join(cache, 'current.tmp'), join(cache, 'current.json'));
      await writeFile(
        join(cache, 'status.json'),
        JSON.stringify({
          schemaVersion: 4,
          state: 'idle',
          updatedAt: createdAt,
          message: 'Ready',
        }),
      );
      return { snapshotPath, imagePath, snapshot };
    }

    await publish('seed', 8);
    await writeFile(join(cache, 'private.json'), 'PRIVATE_TEST_DATA');
    await writeFile(join(directory, 'outside.txt'), 'PRIVATE_TEST_DATA');
    await symlink(
      join(directory, 'outside.txt'),
      join(cache, 'snapshots/seed/images/leak.png'),
    );
    child = spawn(
      process.execPath,
      [
        '--import',
        join(directory, 'no-network.mjs'),
        join(repo, 'scripts/serve.mjs'),
        '--port',
        '0',
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          NEXT_TELEMETRY_DISABLED: '1',
          REDIS_URL: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    exited = once(child, 'exit');
    let output = '';
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Server readiness timed out: ${output}`)),
        25_000,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        child.off('error', fail);
        child.off('exit', earlyExit);
      };
      const fail = (error) => {
        cleanup();
        reject(error);
      };
      const earlyExit = () =>
        fail(new Error(`Server exited before ready: ${output}`));
      child.once('error', fail);
      child.once('exit', earlyExit);
      child.stderr.on('data', (chunk) => {
        output = (output + chunk).slice(-12_000);
      });
      child.stdout.on('data', (chunk) => {
        output = (output + chunk).slice(-12_000);
        const match = output.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          cleanup();
          resolve(match[1]);
        }
      });
    });
    const homepage = await fetch(base);
    assert.equal(homepage.status, 200);
    await homepage.text();
    for (const path of [
      '/other/../actress-cache/private.json',
      '/other/%2e%2e/actress-cache/private.json',
      '/other/../actress-cache/snapshots/seed/images/leak.png',
      '/other//..//actress-cache/private.json',
    ]) {
      const result = await new Promise((resolve, reject) => {
        const req = httpRequest(base, { path }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(result.status, 404, path);
      assert.equal(result.body.includes('PRIVATE_TEST_DATA'), false);
    }
    const missing = await fetch(
      base + '/actress-cache/snapshots/after-start/snapshot.json',
    );
    assert.equal(missing.status, 404);
    await missing.text();
    const next = await publish('after-start', 9);
    const manifest = await fetch(base + '/actress-cache/current.json');
    assert.equal(manifest.headers.get('cache-control'), 'no-store');
    assert.equal((await manifest.json()).snapshotPath, next.snapshotPath);
    const response = await fetch(base + next.snapshotPath);
    assert.equal(response.status, 200, output);
    assert.deepEqual(await response.json(), next.snapshot);
    const image = await fetch(base + next.imagePath);
    assert.equal(image.status, 200);
    assert.equal((await image.arrayBuffer()).byteLength, 4);
    assert.equal(
      child.exitCode,
      null,
      'the same server process must remain running',
    );
  },
);
