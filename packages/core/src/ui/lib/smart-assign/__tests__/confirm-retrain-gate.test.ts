import { describe, it, expect, vi } from "vitest";
import { maybeRetrain } from "../confirm";

describe("maybeRetrain", () => {
  it("runs only when enabled AND triggered", () => {
    const run = vi.fn(() => ({ ran: true, swapped: true, reason: "ok" }));
    expect(maybeRetrain(false, true, run)).toBeNull(); expect(run).not.toHaveBeenCalled();
    expect(maybeRetrain(true, false, run)).toBeNull(); expect(run).not.toHaveBeenCalled();
    expect(maybeRetrain(true, true, run)?.swapped).toBe(true); expect(run).toHaveBeenCalledOnce();
  });
});
