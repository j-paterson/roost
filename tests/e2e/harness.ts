/**
 * WDIO harness helpers for Roost E2E tests.
 *
 * Provides lifecycle hooks that start/stop the local Ollama HTTP stub
 * so that specs can import them directly.
 *
 * Usage in a spec:
 *
 *   import { withOllamaStub } from "./harness";
 *   import type { OllamaStub } from "./ollama-stub";
 *
 *   describe("My spec", function() {
 *     let ollama: OllamaStub;
 *     before(async function() { ollama = await withOllamaStub.start(); });
 *     after(async function()  { await withOllamaStub.stop(ollama); });
 *   });
 *
 * The vault snapshotting and plugin injection are handled by wdio-obsidian-service
 * via the capabilities.vault and capabilities.plugins config in wdio.conf.mts.
 * Specs that need a fresh vault call browser.reloadObsidian({vault: ...}).
 */

import { startOllamaStub, stopOllamaStub } from "./ollama-stub.js";
import type { OllamaStub } from "./ollama-stub.js";

export type { OllamaStub };

const STUB_PORT = parseInt(process.env["OLLAMA_STUB_PORT"] ?? "11435", 10);

export const withOllamaStub = {
    async start(port = STUB_PORT): Promise<OllamaStub> {
        const stub = await startOllamaStub(port);
        // Tell the plugin to use our stub instead of the real Ollama.
        // The plugin reads OLLAMA_HOST from the environment at the Node level
        // before launching, but since Obsidian is a separate process we rely
        // on the test to intercept Ollama API calls at the network level via
        // the stub listening on localhost.  No env var injection needed for
        // the boot smoke test since it doesn't call Ollama.
        return stub;
    },

    async stop(stub: OllamaStub): Promise<void> {
        await stopOllamaStub(stub);
    },
};
