import { useEffect, useState } from 'react';
import {
  initialSnapshotState,
  startSnapshotPolling,
} from '@/lib/snapshot-client';

export function useActressSnapshot() {
  const [state, setState] = useState(initialSnapshotState);
  useEffect(() => startSnapshotPolling({ fetch, onChange: setState }), []);
  return state;
}
