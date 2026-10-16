'use client';

import { useEffect, useState } from 'react';

/** Current time in ms, ticking every `intervalMs`. Starts at 0 on the server/first render to avoid hydration drift. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
