import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearMinnanoAvCache,
  createMinnanoAvEnricher,
} from '../src/server/jav-crawler/minnano-av';

const profile = { name: 'Demo Star', aliases: ['Demo'] };
const list =
  '<h2 class="ttl"><a href="actress123.html">Demo Star</a></h2><p class="furi">でも / Demo Star</p>';
const detail =
  '<h1>Demo Star</h1><table class="rate-table"><tr><td class="t9">総合評価</td><td class="t9">9</td></tr></table>';

test('Minnano outages open the per-run circuit and are never cached as misses', async (t) => {
  for (const failure of [
    403,
    429,
    503,
    'network',
    'body',
    'challenge',
  ] as const) {
    await t.test(String(failure), async (t) => {
      clearMinnanoAvCache();
      t.after(clearMinnanoAvCache);
      let recovered = false;
      let requests = 0;
      t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
        requests++;
        if (!recovered) {
          if (failure === 'network') throw new TypeError('fetch failed');
          if (failure === 'body') {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error('body read failed'));
                },
              }),
            );
          }
          if (failure === 'challenge')
            return new Response('<title>Just a moment...</title>');
          return new Response('Unavailable', { status: failure });
        }
        return new Response(
          String(input).includes('actress_list.php') ? list : detail,
        );
      });
      const run = createMinnanoAvEnricher();
      assert.equal((await run.lookup(profile)).kind, 'unavailable');
      assert.equal(requests, 1);
      assert.equal(run.stats.blocked, 1);
      assert.equal(
        (await run.lookup({ name: 'Another Star', aliases: [] })).kind,
        'unavailable',
      );
      assert.equal(
        requests,
        1,
        'open circuit must not keep hitting the provider',
      );

      recovered = true;
      // Even without clearing caches, an outage must not poison later lookups.
      const nextRun = createMinnanoAvEnricher();
      const result = await nextRun.lookup(profile);
      assert.equal(result.kind, 'matched');
      assert.equal(result.profile.ratings?.overall, 9);
      assert.equal(nextRun.stats.blocked, 0);
      assert.equal(requests, 3);
    });
  }
});

test('a genuine Minnano missing page is not treated as an outage', async (t) => {
  clearMinnanoAvCache();
  t.after(clearMinnanoAvCache);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 404 }),
  );
  const run = createMinnanoAvEnricher();
  assert.equal((await run.lookup(profile)).kind, 'not-found');
  assert.equal(run.stats.blocked, 0);
});
