// @vitest-environment node
//
// Unit test for the one-time auto-run wiring added in plan 037. This covers ONLY
// the pure decision fn + the orchestrator's flag-flip contract — it does NOT
// drive the real fs walk (that's runTweetBodyBackfill's territory, already
// covered by the 031/036 driver tests). The orchestrator takes the driver as an
// injectable param (defaulting to the real runTweetBodyBackfill), so the wiring
// is tested with a fake driver and no module mocking is needed.
import { describe, it, expect, vi } from "vitest";
// Import the enrichments registry FIRST. tweet-body-backfill participates in an
// import cycle with @/lib/enrichments (the registry references
// RENDERED_TWEET_ENRICHMENT, which is defined in tweet-body-backfill). Entering
// that cycle via tweet-body-backfill as the first module leaves the registry's
// .filter reading an undefined entry; importing the registry here forces the
// const to initialize in the correct order. Production never hits this because
// it loads through main.ts -> register-roost-commands -> enrichments first.
import "@/lib/enrichments";
import {
  shouldAutoRunTweetBodyBackfill,
  maybeAutoRunTweetBodyBackfill,
} from "@/sync/tweet-body-backfill";
import type { IRoostPlugin } from "@/types/plugin";

/** Minimal fake plugin exposing just what the orchestrator touches:
 *  settings.tweetBodyBackfillDone, saveSettings(), fireLog(). */
function makeFakePlugin(tweetBodyBackfillDone: boolean | undefined) {
  const plugin = {
    settings: { tweetBodyBackfillDone },
    saveSettings: vi.fn(async () => {}),
    fireLog: vi.fn(),
  } as unknown as IRoostPlugin;
  return plugin;
}

describe("shouldAutoRunTweetBodyBackfill (pure decision fn)", () => {
  it("runs on a fresh vault (flag undefined)", () => {
    expect(shouldAutoRunTweetBodyBackfill(undefined)).toBe(true);
  });
  it("runs when not yet done (flag false)", () => {
    expect(shouldAutoRunTweetBodyBackfill(false)).toBe(true);
  });
  it("skips when already done (flag true)", () => {
    expect(shouldAutoRunTweetBodyBackfill(true)).toBe(false);
  });
});

describe("maybeAutoRunTweetBodyBackfill (orchestrator)", () => {
  it("runs the driver once, sets the flag, and saves", async () => {
    const plugin = makeFakePlugin(false);
    const run = vi.fn(async () => {});

    await maybeAutoRunTweetBodyBackfill(plugin, run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(plugin);
    expect(plugin.settings.tweetBodyBackfillDone).toBe(true);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("no-ops on a second call once the flag is true", async () => {
    const plugin = makeFakePlugin(false);
    const run = vi.fn(async () => {});

    // First call sets the flag.
    await maybeAutoRunTweetBodyBackfill(plugin, run);
    expect(plugin.settings.tweetBodyBackfillDone).toBe(true);

    run.mockClear();
    (plugin.saveSettings as ReturnType<typeof vi.fn>).mockClear();

    // Second call: flag is now true → early-exit, driver not invoked, no save.
    await maybeAutoRunTweetBodyBackfill(plugin, run);
    expect(run).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("does not run when the flag is already true (pre-set)", async () => {
    const plugin = makeFakePlugin(true);
    const run = vi.fn(async () => {});

    await maybeAutoRunTweetBodyBackfill(plugin, run);

    expect(run).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(plugin.settings.tweetBodyBackfillDone).toBe(true);
  });

  it("leaves the flag false and does not throw when the driver fails (retry next load)", async () => {
    const plugin = makeFakePlugin(false);
    const run = vi.fn(async () => {
      throw new Error("boom");
    });

    // Must not throw out of the deferred callback.
    await expect(
      maybeAutoRunTweetBodyBackfill(plugin, run),
    ).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledTimes(1);
    expect(plugin.settings.tweetBodyBackfillDone).toBe(false);
    expect(plugin.saveSettings).not.toHaveBeenCalled();

    // A "failed" line was logged so the retry-on-next-load behaviour is visible.
    const logged = (plugin.fireLog as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(logged).toContain("failed");
    expect(logged).toContain("boom");
  });
});
