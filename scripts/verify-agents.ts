#!/usr/bin/env tsx
/**
 * E2E verification for AgentManager.
 * Spawns real Ollama + embed sidecar, exercises the endpoints the
 * Smart Assign pipeline actually hits, validates shutdown and failure paths.
 *
 * Usage: npm run verify:agents
 *
 * Non-zero exit on any failed check.
 */
import { fileURLToPath } from "url";
import path from "path";
import { AgentManager } from "../packages/core/src/lib/agent-manager";
import { OLLAMA_URL, EMBED_URL, EMBED_MODEL, TOPIC_MODEL, OLLAMA_NUM_CTX } from "../packages/core/src/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_SCRIPT = path.join(__dirname, "embed-sidecar.py");
const PLUGIN_DIR = path.dirname(__dirname);
const VAULT_ROOT = process.env.ROOST_VAULT;
if (!VAULT_ROOT) {
  console.error("ROOST_VAULT env var required (path to the Obsidian vault)");
  process.exit(2);
}
const PYTHON_BIN = process.env.ROOST_SIDECAR_PYTHON
  ?? path.join(VAULT_ROOT, ".roost", "build", "venv", "bin", "python");

type Check = { name: string; passed: boolean; detail?: string };
const results: Check[] = [];

function check(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
}

function indent(msg: string) { console.log("    " + msg); }

async function probe(url: string): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1000);
    const res = await fetch(`${url}/api/tags`, { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

async function main() {
  console.log("[init] Probing current state");
  const ollamaPre = await probe(OLLAMA_URL);
  const sidecarPre = await probe(EMBED_URL);
  indent(`ollama (${OLLAMA_URL}): ${ollamaPre ? "running" : "not running"}`);
  indent(`sidecar (${EMBED_URL}): ${sidecarPre ? "running" : "not running"}`);
  const externalPresent = ollamaPre || sidecarPre;
  if (externalPresent) {
    console.log("\nNOTE: external instance(s) detected. Spawn/shutdown paths will be skipped.");
  }

  // ── [1] ensureReady ────────────────────────────────────────────
  console.log("\n[1] ensureReady");
  const mgr1 = new AgentManager({
    autoStart: true,
    ollamaBinary: "ollama",
    vaultRoot: VAULT_ROOT,
    pluginDir: PLUGIN_DIR,
    pythonBinaryOverride: PYTHON_BIN,
    sidecarScriptOverride: SIDECAR_SCRIPT,
  });
  const t0 = Date.now();
  let mgr1Ready = false;
  try {
    await mgr1.ensureReady(indent);
    mgr1Ready = true;
    check("both agents ready", true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    check("both agents ready", false, e instanceof Error ? e.message : String(e));
  }

  // ── [2] Real embed call ───────────────────────────────────────
  if (mgr1Ready) {
    console.log("\n[2] Embed endpoint contract");
    try {
      const res = await fetch(`${EMBED_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: "verify-agents smoke test" }),
      });
      const body = await res.json() as { embeddings?: unknown };
      const vec = Array.isArray(body.embeddings) ? (body.embeddings[0] as unknown) : null;
      const ok = Array.isArray(vec) && vec.length > 0 && typeof vec[0] === "number";
      check("sidecar returned a vector", ok, ok ? `dim=${(vec as number[]).length}` : `body=${JSON.stringify(body).slice(0, 120)}`);
    } catch (e) {
      check("sidecar returned a vector", false, e instanceof Error ? e.message : String(e));
    }

    // ── [3] Real topic call ───────────────────────────────────────
    console.log("\n[3] Ollama generate endpoint contract");
    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: TOPIC_MODEL,
          prompt: "Respond with exactly: OK",
          stream: false,
          options: { num_ctx: OLLAMA_NUM_CTX },
        }),
      });
      const body = await res.json() as { response?: string };
      const ok = typeof body.response === "string" && body.response.length > 0;
      check("ollama returned a response", ok, ok ? `len=${body.response!.length}` : `body=${JSON.stringify(body).slice(0, 120)}`);
    } catch (e) {
      check("ollama returned a response", false, e instanceof Error ? e.message : String(e));
    }
  } else {
    console.log("\n[2-3] Skipped (agents not ready)");
  }

  // ── [4] Reuse detection ────────────────────────────────────────
  if (mgr1Ready) {
    console.log("\n[4] Reuse detection");
    const mgr2 = new AgentManager({
      autoStart: true,
      ollamaBinary: "ollama",
      vaultRoot: VAULT_ROOT,
      pluginDir: PLUGIN_DIR,
      pythonBinaryOverride: PYTHON_BIN,
      sidecarScriptOverride: SIDECAR_SCRIPT,
    });
    const statusLines: string[] = [];
    const tReuse = Date.now();
    try {
      await mgr2.ensureReady((m) => { statusLines.push(m); indent(m); });
      const dt = Date.now() - tReuse;
      const externalHits = statusLines.filter((l) => l.includes("already running")).length;
      check("second manager detected both as external", externalHits === 2, `${externalHits}/2 matched`);
      check("reuse path under 2s", dt < 2000, `${dt}ms`);
    } catch (e) {
      check("second manager reuse", false, e instanceof Error ? e.message : String(e));
    }
  }

  // ── [5] Shutdown ──────────────────────────────────────────────
  if (!externalPresent && mgr1Ready) {
    console.log("\n[5] Shutdown (only valid when mgr1 spawned them)");
    await mgr1.shutdown();
    await sleep(1000);
    const ollamaAfter = await probe(OLLAMA_URL);
    const sidecarAfter = await probe(EMBED_URL);
    check("ollama process exited", !ollamaAfter);
    check("sidecar process exited", !sidecarAfter);
  } else {
    console.log("\n[5] Shutdown — skipped (external instance(s) detected or mgr1 not ready)");
    // Best-effort cleanup of anything we did spawn.
    await mgr1.shutdown();
  }

  // ── [6] Failure path ──────────────────────────────────────────
  const canTestFailure = !(await probe(OLLAMA_URL)) && !(await probe(EMBED_URL));
  if (canTestFailure) {
    console.log("\n[6] Bogus-binary failure path");
    const mgr3 = new AgentManager({
      autoStart: true,
      ollamaBinary: "definitely-not-a-real-binary-roost-12345",
      vaultRoot: VAULT_ROOT,
      pluginDir: PLUGIN_DIR,
      pythonBinaryOverride: "definitely-not-a-real-binary-roost-12345",
      sidecarScriptOverride: SIDECAR_SCRIPT,
    });
    let threw = false;
    let errMsg = "";
    try {
      await mgr3.ensureReady(indent);
    } catch (e) {
      threw = true;
      errMsg = e instanceof Error ? e.message : String(e);
    }
    check("ensureReady threw", threw, errMsg);
    check("error mentions an agent", threw && (errMsg.includes("Ollama") || errMsg.includes("sidecar")), errMsg);
    await mgr3.shutdown();
  } else {
    console.log("\n[6] Failure path — skipped (agents still reachable)");
  }

  // ── Summary ───────────────────────────────────────────────────
  const fails = results.filter((r) => !r.passed).length;
  const total = results.length;
  console.log(`\n${fails === 0 ? "PASS" : "FAIL"} — ${total - fails}/${total}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-agents crashed:", e);
  process.exit(2);
});
