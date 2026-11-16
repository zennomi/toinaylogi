import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  startSnapshotPolling,
  type SnapshotClientState,
} from '../src/lib/snapshot-client';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type ActressSnapshot,
  type CurrentSnapshot,
} from '../src/lib/actresses';
import { foodAliasesByTier } from '../src/lib/food-aliases';

const root = '/actress-cache';
const statusPath = `${root}/status.json`;
const currentPath = `${root}/current.json`;
const ready = {
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  state: 'idle',
  updatedAt: '2026-11-16T00:00:00.000Z',
  message: 'Ready',
};

function snapshot(id = 'sample-a'): ActressSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: id,
    createdAt: '2026-11-16T00:00:00.000Z',
    source: {
      url: 'https://jav.guru/?s=&orderby=views-monthly&order=DESC&category_name=jav',
      orderBy: 'views-monthly',
      category: 'jav',
      pages: 3,
      listEntries: 1,
      uniqueMovies: 1,
      enrichment: {
        provider: 'mixed',
        attempted: 0,
        matched: 0,
        skipped: 0,
        blocked: 0,
      },
    },
    actresses: [
      {
        id: 'sample-actress',
        sourceUrl: 'https://jav.guru/actress/sample-actress/',
        name: 'Sample actress',
        publicName: foodAliasesByTier[0][0],
        aliases: [],
        imagePath: `${root}/snapshots/${id}/images/sample-actress.jpg`,
        socialLinks: [],
        score: 1,
        tier: 0,
        bestRank: 1,
        appearances: 1,
        contributingMovies: [
          { rank: 1, code: 'TEST-001', movieUrl: 'https://jav.guru/1/test/' },
        ],
      },
    ],
  };
}

function manifest(value = snapshot()): CurrentSnapshot {
  return {
    schemaVersion: value.schemaVersion,
    snapshotId: value.snapshotId,
    snapshotPath: `${root}/snapshots/${value.snapshotId}/snapshot.json`,
    createdAt: value.createdAt,
  };
}

const json = (value: unknown, etag?: string) =>
  Response.json(value, { headers: etag ? { etag } : {} });
const unchanged = () => new Response(null, { status: 304 });
function defaultReply(path: string, value = snapshot()): Response {
  if (path === statusPath) return json(ready);
  if (path === currentPath) return json(manifest(value));
  assert.equal(path, manifest(value).snapshotPath);
  return json(value, '"original"');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Drain promise/body-reader work without sleeping or using wall-clock time.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
class Clock {
  now = 0;
  nextId = 0;
  tasks = new Map<number, { due: number; callback: () => void }>();
  schedule = (callback: () => void, delayMs: number) => {
    const id = ++this.nextId;
    this.tasks.set(id, { due: this.now + delayMs, callback });
    return () => {
      this.tasks.delete(id);
    };
  };
  async advance(ms: number) {
    await settle();
    const end = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.due;
      task.callback();
      await settle();
    }
    this.now = end;
    await settle();
  }
}

type Reply = (path: string, init: RequestInit) => Response | Promise<Response>;
function client(
  t: TestContext,
  reply: Reply = (path) => defaultReply(path),
  timing: { pollIntervalMs?: number; requestTimeoutMs?: number } = {},
) {
  const clock = new Clock();
  const calls: { path: string; init: RequestInit }[] = [];
  const states: SnapshotClientState[] = [];
  const stop = startSnapshotPolling({
    fetch: async (input, init = {}) => {
      const path = String(input);
      calls.push({ path, init });
      return reply(path, init);
    },
    schedule: clock.schedule,
    onChange: (state) => states.push(state),
    ...timing,
  });
  t.after(stop);
  return {
    clock,
    calls,
    states,
    stop,
    get state() {
      assert.ok(states.length, 'a completed poll must publish state');
      return states.at(-1)!;
    },
  };
}

test('loads validated local data with uncached control files and revalidated snapshots', async (t) => {
  const c = client(t);
  await settle();
  assert.equal(c.state.snapshot?.snapshotId, 'sample-a');
  assert.equal(c.state.error, null);
  assert.equal(c.state.status?.state, 'idle');
  assert.deepEqual(
    c.calls.map(({ path }) => path),
    [statusPath, currentPath, manifest().snapshotPath],
  );
  assert.deepEqual(
    c.calls.map(({ init }) => init.cache),
    ['no-store', 'no-store', 'no-cache'],
  );
  for (const { init } of c.calls) {
    assert.equal(init.mode, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.signal?.aborted, false);
  }
  assert.equal(c.clock.tasks.size, 1, 'only the next poll remains scheduled');
});

test('slow body consumption never overlaps polls; the next delay starts at completion', async (t) => {
  const body = deferred<unknown>();
  const c = client(
    t,
    (path) => {
      if (path === manifest().snapshotPath)
        return Object.assign(json(null), { json: () => body.promise });
      return defaultReply(path);
    },
    { requestTimeoutMs: 60_000 },
  );
  await settle();
  await c.clock.advance(12_000);
  assert.equal(c.calls.length, 3);
  assert.equal(c.states.length, 0);
  assert.equal(c.clock.tasks.size, 1, 'only the request deadline is pending');
  body.resolve(snapshot());
  await settle();
  assert.equal(c.states.length, 1);
  await c.clock.advance(3_999);
  assert.equal(c.calls.length, 3);
  await c.clock.advance(1);
  assert.equal(c.calls.length, 6);
  assert.equal(c.states.length, 2);
});

for (const phase of ['response', 'body'] as const) {
  test(`bounds an initial stalled ${phase}, aborts it and ignores its late completion`, async (t) => {
    const response = deferred<Response>();
    const body = deferred<unknown>();
    let stall = true;
    const c = client(t, (path) => {
      if (stall && path === manifest().snapshotPath)
        return phase === 'response'
          ? response.promise
          : Object.assign(json(null), { json: () => body.promise });
      const next = snapshot();
      next.actresses[0].age = 25;
      return defaultReply(path, next);
    });
    await settle();
    const signal = c.calls.at(-1)!.init.signal!;
    await c.clock.advance(5_999);
    assert.equal(c.states.length, 0);
    assert.equal(signal.aborted, false);
    await c.clock.advance(1);
    assert.equal(signal.aborted, true);
    assert.equal(c.state.snapshot, null);
    assert.equal(c.state.error?.kind, 'delivery');
    assert.match(
      c.state.error!.detail,
      /snapshot\.json: Timed out after 6000 ms/,
    );
    // Even an idle/Ready producer cannot make failed delivery successful.
    assert.equal(c.state.status?.message, 'Ready');
    assert.equal(c.clock.tasks.size, 1);
    stall = false;
    await c.clock.advance(4_000);
    const recovered = c.state.snapshot;
    assert.equal(recovered?.actresses[0].age, 25);
    assert.equal(c.state.error, null);
    const count = c.states.length;
    response.resolve(json(snapshot()));
    body.resolve(snapshot());
    await settle();
    assert.equal(c.states.length, count);
    assert.equal(c.state.snapshot, recovered);
    assert.equal(c.calls.length, 6);
  });
}

test('the timeout includes headers already received, not a fresh body-only deadline', async (t) => {
  const response = deferred<Response>();
  const body = deferred<unknown>();
  const c = client(t, (path) =>
    path === currentPath ? response.promise : defaultReply(path),
  );
  await settle();
  const signal = c.calls.at(-1)!.init.signal!;
  await c.clock.advance(5_000);
  response.resolve(Object.assign(json(null), { json: () => body.promise }));
  await settle();
  await c.clock.advance(999);
  assert.equal(c.states.length, 0);
  await c.clock.advance(1);
  assert.equal(signal.aborted, true);
  assert.equal(c.state.error?.kind, 'delivery');
  assert.match(c.state.error!.detail, /current\.json: Timed out/);
});

for (const path of [statusPath, currentPath, manifest().snapshotPath]) {
  for (const phase of ['response', 'body'] as const) {
    test(`cleanup aborts ${path} during ${phase}, removes timers and prevents later requests`, async (t) => {
      const response = deferred<Response>();
      const body = deferred<unknown>();
      const c = client(t, (requested) => {
        if (requested !== path) return defaultReply(requested);
        return phase === 'response'
          ? response.promise
          : Object.assign(json(null), { json: () => body.promise });
      });
      await settle();
      const count = c.calls.length;
      const signal = c.calls.at(-1)!.init.signal!;
      c.stop();
      await settle();
      assert.equal(signal.aborted, true);
      assert.equal(c.clock.tasks.size, 0);
      response.resolve(defaultReply(path));
      body.resolve(await defaultReply(path).json());
      await c.clock.advance(60_000);
      assert.equal(c.calls.length, count);
      assert.equal(c.states.length, 0);
    });
  }
}

test('cleanup cancels an already scheduled next poll', async (t) => {
  const c = client(t);
  await settle();
  c.stop();
  assert.equal(c.clock.tasks.size, 0);
  await c.clock.advance(60_000);
  assert.equal(c.calls.length, 3);
  assert.equal(c.states.length, 1);
});

const deliveryFailures: [string, (path: string) => Response][] = [
  [
    'manifest HTTP failure',
    (path) =>
      path === currentPath
        ? new Response(null, { status: 503 })
        : defaultReply(path),
  ],
  [
    'invalid manifest',
    (path) => (path === currentPath ? json({}) : defaultReply(path)),
  ],
  [
    'snapshot HTTP failure',
    (path) =>
      path === manifest(snapshot('sample-b')).snapshotPath
        ? new Response(null, { status: 404 })
        : defaultReply(path, snapshot('sample-b')),
  ],
  [
    'invalid JSON',
    (path) =>
      path === manifest(snapshot('sample-b')).snapshotPath
        ? new Response('{broken')
        : defaultReply(path, snapshot('sample-b')),
  ],
  [
    'invalid snapshot',
    (path) =>
      path === manifest(snapshot('sample-b')).snapshotPath
        ? json({})
        : defaultReply(path, snapshot('sample-b')),
  ],
];
for (const [name, failure] of deliveryFailures) {
  test(`preserves the last valid snapshot, warns and recovers after ${name}`, async (t) => {
    let reply: Reply = (path) => defaultReply(path);
    const c = client(t, (path, init) => reply(path, init));
    await settle();
    const previous = c.state.snapshot;
    reply = failure;
    await c.clock.advance(4_000);
    assert.equal(c.state.snapshot, previous);
    assert.equal(c.state.error?.kind, 'delivery');
    if (name.includes('HTTP'))
      assert.match(c.state.error!.detail, /HTTP (503|404)/);
    reply = (path) => defaultReply(path, snapshot('sample-b'));
    await c.clock.advance(4_000);
    assert.equal(c.state.snapshot?.snapshotId, 'sample-b');
    assert.equal(c.state.error, null);
    assert.equal(
      new Headers(c.calls.at(-1)!.init.headers).has('If-None-Match'),
      false,
    );
  });
}

test('same-ID snapshots are conditionally reloaded after in-place enrichment', async (t) => {
  let generation = 0;
  const c = client(t, (path) => {
    if (path !== manifest().snapshotPath) return defaultReply(path);
    if (generation === 1) return unchanged();
    const value = snapshot();
    if (generation >= 2) value.actresses[0].age = 29;
    return json(value, generation >= 2 ? '"enriched"' : '"original"');
  });
  await settle();
  const original = c.state.snapshot;
  generation = 1;
  await c.clock.advance(4_000);
  assert.equal(
    new Headers(c.calls.at(-1)!.init.headers).get('If-None-Match'),
    '"original"',
  );
  assert.equal(c.state.snapshot, original);
  assert.equal(c.state.error, null);
  generation = 2;
  await c.clock.advance(4_000);
  assert.equal(c.state.snapshot?.snapshotId, original?.snapshotId);
  assert.equal(c.state.snapshot?.actresses[0].age, 29);
  assert.notEqual(c.state.snapshot, original);
  const enriched = c.state.snapshot;
  generation = 3;
  await c.clock.advance(4_000);
  assert.equal(
    new Headers(c.calls.at(-1)!.init.headers).get('If-None-Match'),
    '"enriched"',
  );
  assert.equal(
    c.state.snapshot,
    enriched,
    'identical 200 must not reset the reel',
  );
});

test('same-ID reloads also work without an ETag', async (t) => {
  const value = snapshot();
  const c = client(t, (path) =>
    path === manifest().snapshotPath ? json(value) : defaultReply(path),
  );
  await settle();
  value.actresses[0].age = 30;
  await c.clock.advance(4_000);
  assert.equal(c.state.snapshot?.actresses[0].age, 30);
  assert.equal(c.calls.at(-1)!.init.cache, 'no-cache');
  assert.equal(
    new Headers(c.calls.at(-1)!.init.headers).has('If-None-Match'),
    false,
  );
});

test('an invalid same-ID response cannot poison the accepted ETag or snapshot', async (t) => {
  let broken = false;
  const c = client(t, (path) =>
    broken && path === manifest().snapshotPath
      ? json({ ...snapshot(), schemaVersion: 99 }, '"invalid"')
      : defaultReply(path),
  );
  await settle();
  const previous = c.state.snapshot;
  broken = true;
  await c.clock.advance(4_000);
  assert.equal(c.state.snapshot, previous);
  assert.equal(c.state.error?.kind, 'delivery');
  broken = false;
  await c.clock.advance(4_000);
  assert.equal(
    new Headers(c.calls.at(-1)!.init.headers).get('If-None-Match'),
    '"original"',
  );
  assert.equal(c.state.error, null);
});

for (const [name, control] of [
  [
    'external path',
    { ...manifest(), snapshotPath: 'https://example.com/snapshot.json' },
  ],
  [
    'mismatched path ID',
    { ...manifest(), snapshotPath: manifest(snapshot('other')).snapshotPath },
  ],
  ['unsupported schema', { ...manifest(), schemaVersion: 99 }],
  ['invalid creation date', { ...manifest(), createdAt: 'not-a-date' }],
] as const) {
  test(`rejects a manifest with ${name} before requesting a snapshot`, async (t) => {
    const c = client(t, (path) =>
      path === currentPath ? json(control) : defaultReply(path),
    );
    await settle();
    assert.equal(c.state.snapshot, null);
    assert.equal(c.state.error?.kind, 'delivery');
    assert.equal(c.calls.length, 2);
  });
}

for (const [name, change] of [
  ['ID', { snapshotId: 'other' }],
  ['creation time', { createdAt: '2026-11-17T00:00:00.000Z' }],
  ['schema', { schemaVersion: 3 }],
] as const) {
  test(`rejects a valid snapshot whose ${name} differs from the manifest`, async (t) => {
    const c = client(t, (path) =>
      path === manifest().snapshotPath
        ? json({ ...snapshot(), ...change })
        : defaultReply(path),
    );
    await settle();
    assert.equal(c.state.snapshot, null);
    assert.equal(c.state.error?.kind, 'delivery');
    assert.match(c.state.error!.detail, /mismatched snapshot/);
  });
}

test('coherent legacy schema-3 manifests and snapshots still load', async (t) => {
  const c = client(t, (path) => {
    if (path === currentPath) return json({ ...manifest(), schemaVersion: 3 });
    if (path === manifest().snapshotPath)
      return json({ ...snapshot(), schemaVersion: 3 });
    return defaultReply(path);
  });
  await settle();
  assert.equal(c.state.snapshot?.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(c.state.error, null);
});

test('does not accept a 304 without a matching validated representation', async (t) => {
  const c = client(t, (path) =>
    path === manifest().snapshotPath ? unchanged() : defaultReply(path),
  );
  await settle();
  assert.equal(c.state.snapshot, null);
  assert.match(c.state.error!.detail, /HTTP 304/);
});

for (const failure of ['HTTP', 'schema', 'state type', 'timeout'] as const) {
  test(`status ${failure} failure stays visible without blocking snapshot delivery, then recovers`, async (t) => {
    let fail = true;
    const c = client(t, (path) => {
      if (path !== statusPath || !fail) return defaultReply(path);
      if (failure === 'HTTP') return new Response(null, { status: 503 });
      if (failure === 'schema') return json({ ...ready, schemaVersion: 99 });
      if (failure === 'state type') return json({ ...ready, state: ['idle'] });
      return new Promise<Response>(() => {});
    });
    await c.clock.advance(failure === 'timeout' ? 6_000 : 0);
    assert.ok(c.state.snapshot);
    assert.equal(c.state.status, null);
    assert.equal(c.state.error?.kind, 'status');
    assert.match(c.state.error!.detail, /status\.json:/);
    if (failure === 'HTTP') assert.match(c.state.error!.detail, /HTTP 503/);
    fail = false;
    await c.clock.advance(4_000);
    assert.equal(c.state.status?.state, 'idle');
    assert.equal(c.state.error, null);
  });
}

test('an HTTP error aborts its unread body before the next request starts', async (t) => {
  let failedSignal: AbortSignal | null = null;
  const c = client(t, (path, init) => {
    if (path === statusPath) {
      failedSignal = init.signal ?? null;
      return new Response(null, { status: 503 });
    }
    assert.equal(failedSignal?.aborted, true);
    return defaultReply(path);
  });
  await settle();
  assert.equal(c.state.error?.kind, 'status');
  assert.ok(c.state.snapshot);
});

test('a later timeout preserves data and a successful 304 clears the stale warning', async (t) => {
  let stage = 0;
  const c = client(t, (path) => {
    if (path === manifest().snapshotPath) {
      if (stage === 1) return new Promise<Response>(() => {});
      if (stage === 2) return unchanged();
    }
    return defaultReply(path);
  });
  await settle();
  const previous = c.state.snapshot;
  stage = 1;
  await c.clock.advance(10_000);
  assert.equal(c.state.snapshot, previous);
  assert.equal(c.state.error?.kind, 'delivery');
  assert.match(c.state.error!.detail, /Timed out/);
  stage = 2;
  await c.clock.advance(4_000);
  assert.equal(c.state.snapshot, previous);
  assert.equal(c.state.error, null);
});

test('source refresh failures retain HTTP diagnostics even when snapshot delivery succeeds', async (t) => {
  let failed = true;
  const message = 'Source https://jav.guru/: HTTP 403';
  const c = client(t, (path) =>
    path === statusPath && failed
      ? json({ ...ready, state: 'error', message })
      : defaultReply(path),
  );
  await settle();
  assert.ok(c.state.snapshot);
  assert.equal(c.state.error?.kind, 'refresh');
  assert.equal(c.state.error?.detail, message);
  assert.equal(c.state.status?.message, message);
  failed = false;
  await c.clock.advance(4_000);
  assert.equal(c.state.error, null);
});

test('delivery failures do not hide simultaneous source HTTP diagnostics', async (t) => {
  const c = client(t, (path) =>
    path === statusPath
      ? json({ ...ready, state: 'error', message: 'Source HTTP 429' })
      : new Response(null, { status: 404 }),
  );
  await settle();
  assert.equal(c.state.snapshot, null);
  assert.equal(c.state.error?.kind, 'delivery');
  assert.match(c.state.error!.detail, /current\.json: HTTP 404/);
  assert.match(c.state.error!.detail, /Source HTTP 429/);
});
