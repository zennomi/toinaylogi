import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mapLimit } from '../src/server/jav-crawler/fetch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('mapLimit preserves order and enforces bounded concurrency', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapLimit([0, 1, 2, 3, 4], 2, async (item, index) => {
    assert.equal(item, index);
    peak = Math.max(peak, ++active);
    await setImmediate();
    active--;
    return item * 2;
  });
  assert.deepEqual(result, [0, 2, 4, 6, 8]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 2, async () => 0), []);
});

test('mapLimit stops assigning on failure and drains even later rejecting workers', async () => {
  const first = deferred<number>();
  const second = deferred<number>();
  const started: number[] = [];
  const firstError = new Error('first failure');
  let settled = false;
  const outcome = mapLimit([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    return item === 0 ? first.promise : second.promise;
  }).then(
    () => assert.fail('expected failure'),
    (error) => {
      settled = true;
      return error;
    },
  );
  first.reject(firstError);
  await setImmediate();
  assert.deepEqual(started, [0, 1]);
  assert.equal(
    settled,
    false,
    'caller must not clean up while work is running',
  );
  second.reject(new Error('later failure'));
  assert.equal(await outcome, firstError);
  assert.deepEqual(started, [0, 1]);
});

test('mapLimit catches synchronous and undefined failures without starting more work', async () => {
  let calls = 0;
  await assert.rejects(
    mapLimit([0, 1, 2], 3, () => {
      calls++;
      throw new Error('sync failure');
    }),
    /sync failure/,
  );
  assert.equal(calls, 1);
  const result = await mapLimit([0, 1], 1, async () => {
    throw undefined;
  }).then(
    () => 'unexpected success',
    (error) => error,
  );
  assert.equal(result, undefined);
});

test('mapLimit rejects invalid limits even for an empty input', async () => {
  for (const limit of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      mapLimit([], limit, async () => 0),
      RangeError,
    );
  }
});
