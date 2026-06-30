import { describe, it, expect, vi } from "vitest";
import { registerRoostCommands } from "@/plugin/register-roost-commands";

describe("dev command gating", () => {
  it("does not register export-x-cookies / debug-probe-bootstrap by default", () => {
    const ids: string[] = [];
    // Minimal plugin stub: capture command ids; stub every method registerRoostCommands
    // calls at registration time (not inside callbacks — those are never invoked here).
    const plugin = {
      addCommand: (c: { id: string }) => { ids.push(c.id); },
      addRibbonIcon: vi.fn(),
      app: {},
      settings: {
        integrations: { vaultSearch: false },
      },
    } as any;
    registerRoostCommands(plugin);
    expect(ids).not.toContain("export-x-cookies");
    expect(ids).not.toContain("debug-probe-bootstrap");
    expect(ids).not.toContain("open-instagram-login");
    expect(ids).not.toContain("export-instagram-cookies");
  });
});
