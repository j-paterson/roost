/**
 * Render trace — diagnostic instrumentation for gallery flash investigation.
 *
 * Active only when window.__roostTraceEnabled === true. Tests flip the flag
 * before driving an action and read window.__roostTrace afterwards. Production
 * builds pay only the cost of one boolean check + one Date.now() per call.
 */

interface RoostTraceEntry {
  t: number;
  name: string;
  data?: Record<string, unknown>;
}

interface RoostTraceWindow {
  __roostTraceEnabled?: boolean;
  __roostTrace?: RoostTraceEntry[];
  __roostTraceStart?: number;
}

export function traceEvent(name: string, data?: Record<string, unknown>): void {
  const w = (typeof window !== "undefined" ? (window as any) : null) as RoostTraceWindow | null;
  if (!w?.__roostTraceEnabled) return;
  if (!w.__roostTrace) {
    w.__roostTrace = [];
    w.__roostTraceStart = Date.now();
  }
  const start = w.__roostTraceStart ?? Date.now();
  w.__roostTrace.push({ t: Date.now() - start, name, data });
}
