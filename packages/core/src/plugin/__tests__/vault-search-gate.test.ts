import { describe, it, expect } from "vitest";
import { vaultSearchGate } from "@/plugin/register-roost-commands";

describe("vaultSearchGate", () => {
  it("blocks when the flag is off", () => {
    expect(vaultSearchGate(false, () => "/usr/bin/vault-search")).toEqual({ ok: false, reason: "off" });
  });
  it("blocks when the binary is missing", () => {
    expect(vaultSearchGate(true, () => null)).toEqual({ ok: false, reason: "missing" });
  });
  it("allows when flag on and binary found", () => {
    expect(vaultSearchGate(true, () => "/usr/bin/vault-search")).toEqual({ ok: true });
  });
});
