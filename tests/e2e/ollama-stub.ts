import * as http from "http";

/** Response can be a static string/object or an async factory for dynamic/delayed replies. */
type ResponseValue = string | object | (() => Promise<string | object>);

export interface OllamaStub {
  server: http.Server;
  /**
   * Register a handler for prompts matching `match`.
   *
   * `response` can be:
   *   - a string — returned as-is
   *   - a plain object — JSON-serialised
   *   - an async function `() => Promise<string|object>` — called per request,
   *     allowing delayed or dynamic responses (e.g. for cancel-timing tests)
   *
   * Handlers are checked in registration order (first registered wins for any
   * given prompt).  Register specific patterns before catch-alls.
   */
  respond(match: string | RegExp, response: ResponseValue): void;
  reset(): void;
  port: number;
  unexpectedCalls(): { prompt: string; fingerprint: string }[];
}

interface Handler {
  match: string | RegExp;
  response: ResponseValue;
}

export async function startOllamaStub(port = 11434): Promise<OllamaStub> {
  // Handlers are stored in registration order; the first matching handler wins.
  const handlers: Handler[] = [];
  const unexpected: { prompt: string; fingerprint: string }[] = [];

  const server = http.createServer(async (req, res) => {
    // Probe endpoints — respond 200 with empty model list so AgentManager.probeUrl
    // succeeds. probeUrl issues a GET to /api/tags; returning 200 marks the agent
    // as "external" without blocking Smart Assign startup.
    if (req.method !== "POST" || req.url === "/api/tags") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [] }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf-8");

    let prompt = "";
    try {
      const parsed = JSON.parse(body || "{}");
      prompt = parsed.prompt ?? "";
    } catch { /* ignore */ }

    // Find the first handler whose match pattern matches the prompt.
    // Handlers are stored in registration order (push to end), so
    // the earliest-registered handler that matches wins.
    const matched = handlers.find(h =>
      typeof h.match === "string" ? prompt.includes(h.match) : h.match.test(prompt)
    );

    if (!matched) {
      const fingerprint = prompt.slice(0, 80).replace(/\s+/g, " ");
      unexpected.push({ prompt, fingerprint });
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "no stub handler for prompt", fingerprint }));
      return;
    }

    // Resolve the response value (static or async factory).
    let responseValue: string | object;
    if (typeof matched.response === "function") {
      responseValue = await (matched.response as () => Promise<string | object>)();
    } else {
      responseValue = matched.response;
    }

    const responseStr = typeof responseValue === "string"
      ? responseValue
      : JSON.stringify(responseValue);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ response: responseStr }));
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    server,
    port,
    respond(match, response) {
      // Append to end so registration order = check order (first registered wins).
      // This is intentionally append (not unshift/prepend) so that callers can
      // register a catch-all first and override it with specific patterns later.
      handlers.push({ match, response });
    },
    reset() { handlers.length = 0; unexpected.length = 0; },
    unexpectedCalls() { return [...unexpected]; },
  };
}

export async function stopOllamaStub(stub: OllamaStub): Promise<void> {
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
}
