import { describe, it, expect } from "vitest";
import { buildIntegrationRows } from "@/ui/hub/integration-rows";

describe("buildIntegrationRows", () => {
  const flags = { ollama: true, sidecar: false, ffmpeg: false, vaultSearch: false };
  const status = { ollama: "available", sidecar: "unknown", ffmpeg: "unknown", "vault-search": "unknown" } as const;

  it("produces a row per registry integration", () => {
    const rows = buildIntegrationRows(flags, status);
    expect(rows.map((r) => r.id).sort()).toEqual(["ffmpeg", "ollama", "sidecar", "vault-search"]);
  });

  it("maps the enabled flag and status onto each row", () => {
    const rows = buildIntegrationRows(flags, status);
    const ollama = rows.find((r) => r.id === "ollama")!;
    expect(ollama.enabled).toBe(true);
    expect(ollama.status).toBe("available");
    expect(ollama.label.length).toBeGreaterThan(0);
    expect(ollama.setup.length).toBeGreaterThan(0);
    const sidecar = rows.find((r) => r.id === "sidecar")!;
    expect(sidecar.enabled).toBe(false);
  });
});
