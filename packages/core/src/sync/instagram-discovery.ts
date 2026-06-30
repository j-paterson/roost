/**
 * Pure helpers for the Instagram API discovery spike. The injected probe records
 * raw observed calls; this module filters + summarizes them into findings.
 */

/** True iff `url` is an Instagram API call: substring `instagram.com` AND (`/api/` or `/graphql`).
 *  Note: this is a deliberately-broad URL-string match for the discovery spike, not strict host
 *  isolation. `cdninstagram.com` media is excluded by the path guard (no `/api/`/`/graphql`), NOT
 *  by the host check (`instagram.com` is a substring of `cdninstagram.com`). Fine for capturing
 *  broadly during discovery; Phase 2 should tighten to real host parsing if it productionizes. */
export function isInstagramApiCall(url: string): boolean {
  if (!url.includes("instagram.com")) return false;
  return url.includes("/api/") || url.includes("/graphql");
}

export interface ObservedCall {
  url: string;
  method: string;
  reqHeaders: Record<string, string>;
  reqBody?: string;
  status?: number;
  respSample?: string;
  at: number;
}

export interface Endpoint {
  method: string;
  path: string;
  exampleUrl: string;
  authHeaders: Record<string, string>;
  exampleQuery: string;
  respSampleHead: string;
  count: number;
}

export interface Findings {
  totalObserved: number;
  apiCalls: number;
  endpoints: Endpoint[];
}

function splitUrl(url: string): { path: string; query: string } {
  const q = url.indexOf("?");
  if (q < 0) return { path: url, query: "" };
  return { path: url.slice(0, q), query: url.slice(q + 1) };
}

/** Path without the origin, for a readable grouping key. */
function pathname(path: string): string {
  return path.replace(/^https?:\/\/[^/]+/, "");
}

export function summarizeFindings(calls: ObservedCall[]): Findings {
  const api = calls.filter((c) => isInstagramApiCall(c.url));
  const groups = new Map<string, Endpoint>();
  for (const c of api) {
    const { path, query } = splitUrl(c.url);
    const p = pathname(path);
    const key = `${c.method} ${p}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, {
        method: c.method,
        path: p,
        exampleUrl: c.url,
        authHeaders: c.reqHeaders,
        exampleQuery: query,
        respSampleHead: (c.respSample ?? "").slice(0, 400),
        count: 1,
      });
    }
  }
  const endpoints = [...groups.values()].sort((a, b) => b.count - a.count);
  return { totalObserved: calls.length, apiCalls: api.length, endpoints };
}
