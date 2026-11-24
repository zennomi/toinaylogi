import { refreshActressData } from './crawler';
import { isDue, REFRESH_INTERVAL_MS, retryPendingLockRelease } from './store';

const RETRY = 15 * 60 * 1000;

export function createActressRefreshScheduler({
  checkDue = isDue,
  recoverRelease = retryPendingLockRelease,
  refresh = refreshActressData,
  later = setTimeout,
}: {
  checkDue?: () => Promise<boolean>;
  recoverRelease?: () => Promise<void>;
  refresh?: () => Promise<boolean>;
  later?: typeof setTimeout;
} = {}) {
  let started = false;

  async function schedule() {
    let delay = RETRY;
    try {
      // Publication may have succeeded before lock cleanup failed. Recover our
      // pending release even when that new snapshot is not due for another week.
      await recoverRelease();
      if (await checkDue()) {
        if (await refresh()) delay = REFRESH_INTERVAL_MS;
      } else {
        delay = 60 * 60 * 1000;
      }
    } catch (error) {
      console.error('[jav-crawler] Scheduled refresh failed', error);
    } finally {
      // Includes due-check, acquisition and cleanup failures. Never leave the
      // scheduler marked started without arranging its next attempt.
      later(() => void schedule(), delay).unref();
    }
  }

  return function start() {
    if (started) return;
    started = true;
    void schedule();
  };
}

export const startActressRefreshScheduler = createActressRefreshScheduler();
