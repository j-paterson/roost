import { useEffect, useState } from "react";

/** Re-render on a fixed interval. Returns the current tick number so consumers
 *  can use it as a dependency if needed. */
export function useTickEvery(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return tick;
}
