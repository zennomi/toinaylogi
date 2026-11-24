import {
  ACTRESS_CACHE_ROOT,
  validateStatus,
  validateCurrent,
  validateSnapshot,
  type ActressSnapshot,
  type CurrentSnapshot,
  type RefreshStatus,
} from './actresses';

const currentPath = `${ACTRESS_CACHE_ROOT}/current.json`;
const statusPath = `${ACTRESS_CACHE_ROOT}/status.json`;

export type SnapshotClientState = {
  snapshot: ActressSnapshot | null;
  status: RefreshStatus | null;
  error: {
    kind: 'delivery' | 'status' | 'refresh';
    detail: string;
  } | null;
};

export const initialSnapshotState: SnapshotClientState = {
  snapshot: null,
  status: null,
  error: null,
};

type Schedule = (callback: () => void, delayMs: number) => () => void;
const scheduleTimeout: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

type SnapshotPollingOptions = {
  fetch: typeof fetch;
  onChange: (state: SnapshotClientState) => void;
  schedule?: Schedule;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
};

type CachedSnapshot = {
  current: CurrentSnapshot;
  snapshot: ActressSnapshot;
  etag: string | null;
  fingerprint: string;
};

const diagnostic = (error: unknown) =>
  (error instanceof Error ? error.message : 'Request failed').slice(0, 400);

/** One poll at a time; cleanup also cancels response-body consumption. */
export function startSnapshotPolling({
  fetch: fetchLocal,
  onChange,
  schedule = scheduleTimeout,
  pollIntervalMs = 4_000,
  requestTimeoutMs = 6_000,
}: SnapshotPollingOptions): () => void {
  let stopped = false;
  let activeRequest: AbortController | null = null;
  let cancelNextPoll: (() => void) | undefined;
  let cached: CachedSnapshot | null = null;

  async function fetchJson(
    path: string,
    cache: RequestCache = 'no-store',
    etag?: string | null,
  ) {
    const controller = new AbortController();
    activeRequest = controller;
    const { signal } = controller;
    let rejectAborted: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = () => reject(signal.reason);
      signal.addEventListener('abort', rejectAborted, { once: true });
    });
    const cancelTimeout = schedule(
      () =>
        controller.abort(new Error(`Timed out after ${requestTimeoutMs} ms`)),
      requestTimeoutMs,
    );
    try {
      // The deadline covers both headers and JSON. Racing the abort also
      // bounds a stalled transport/body reader that fails to reject on abort.
      return await Promise.race([
        aborted,
        (async () => {
          const response = await fetchLocal(path, {
            cache,
            mode: 'same-origin',
            redirect: 'error',
            signal,
            ...(etag ? { headers: { 'If-None-Match': etag } } : {}),
          });
          signal.throwIfAborted();
          if (response.status === 304 && etag) return { response, body: null };
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body: unknown = await response.json();
          signal.throwIfAborted();
          return { response, body };
        })(),
      ]);
    } catch (error) {
      // HTTP errors can arrive before a slow response body has finished.
      controller.abort(error);
      throw new Error(`${path}: ${diagnostic(error)}`);
    } finally {
      cancelTimeout();
      signal.removeEventListener('abort', rejectAborted);
      activeRequest = null;
    }
  }

  async function loadSnapshot() {
    const { body } = await fetchJson(currentPath);
    if (stopped) return;
    const current = validateCurrent(body);
    if (!current) throw new Error(`${currentPath}: Invalid manifest`);

    const matchesCache =
      cached &&
      cached.current.snapshotId === current.snapshotId &&
      cached.current.schemaVersion === current.schemaVersion &&
      cached.current.createdAt === current.createdAt;
    // IDs can be enriched in place. Always revalidate, even when unchanged.
    const result = await fetchJson(
      current.snapshotPath,
      'no-cache',
      matchesCache ? cached?.etag : undefined,
    );
    if (stopped || result.response.status === 304) return;
    const next = validateSnapshot(result.body);
    if (
      !next ||
      (result.body as Record<string, unknown>).schemaVersion !==
        current.schemaVersion ||
      next.snapshotId !== current.snapshotId ||
      next.createdAt !== current.createdAt
    )
      throw new Error(
        `${current.snapshotPath}: Invalid or mismatched snapshot`,
      );

    const fingerprint = JSON.stringify(next);
    cached = {
      current,
      // Avoid resetting the reel when a revalidated 200 has identical data.
      snapshot: cached?.fingerprint === fingerprint ? cached.snapshot : next,
      etag: result.response.headers.get('etag'),
      fingerprint,
    };
  }

  async function poll() {
    let status: RefreshStatus | null = null;
    let statusError = '';
    let deliveryError = '';
    try {
      const { body } = await fetchJson(statusPath);
      status = validateStatus(body);
      if (!status) throw new Error(`${statusPath}: Invalid status`);
      if (status.state === 'error')
        statusError = status.message || 'Local refresh failed';
    } catch (error) {
      statusError = diagnostic(error);
    }
    if (stopped) return;
    // A broken status endpoint must not prevent delivery of a valid snapshot.
    try {
      await loadSnapshot();
    } catch (error) {
      deliveryError = diagnostic(error);
    }
    if (stopped) return;
    onChange({
      snapshot: cached?.snapshot ?? null,
      status,
      error:
        deliveryError || statusError
          ? {
              kind: deliveryError
                ? 'delivery'
                : status?.state === 'error'
                  ? 'refresh'
                  : 'status',
              detail: [deliveryError, statusError].filter(Boolean).join('; '),
            }
          : null,
    });
    // Schedule from completion, never from a fixed interval. Three bounded
    // requests make the first success/error available within 18 seconds.
    if (!stopped) cancelNextPoll = schedule(() => void poll(), pollIntervalMs);
  }

  void poll();
  return () => {
    stopped = true;
    cancelNextPoll?.();
    activeRequest?.abort(new Error('Snapshot polling stopped'));
  };
}
