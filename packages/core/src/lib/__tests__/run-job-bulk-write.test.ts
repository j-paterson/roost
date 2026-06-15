// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the quiet-window helper so it resolves immediately — keeps the test fast
// and deterministic (no real timers, no metadataCache events to drive). The
// factory is hoisted above imports, so define the spy inline and read it back
// via the mocked module below.
vi.mock("@/lib/metadata-cache-quiet", () => ({
  waitForMetadataQuiet: vi.fn(async () => {}),
}));

import { runJobWithBulkWriteFlag, type BulkWriteHost } from "@/lib/run-job-bulk-write";
import { waitForMetadataQuiet } from "@/lib/metadata-cache-quiet";

const waitForMetadataQuietMock = vi.mocked(waitForMetadataQuiet);

/** A minimal fake of the RoostPlugin surface the wrapper touches. */
function createHost(): BulkWriteHost {
  return {
    bulkWriteInProgress: false,
    fireDataRefresh: vi.fn(),
    // Only the reference matters here — waitForMetadataQuiet is mocked out.
    app: { metadataCache: {} as never },
  };
}

describe("runJobWithBulkWriteFlag", () => {
  beforeEach(() => {
    waitForMetadataQuietMock.mockClear();
  });

  it("sets bulkWriteInProgress while fn runs and clears it after, refreshing once", async () => {
    const host = createHost();
    let flagDuringRun: boolean | null = null;

    const result = await runJobWithBulkWriteFlag(host, async () => {
      flagDuringRun = host.bulkWriteInProgress;
      return 42;
    });

    // 1. Flag was true while the job ran.
    expect(flagDuringRun).toBe(true);
    // 2. Flag dropped and exactly one rebuild fired after the job resolved.
    expect(host.bulkWriteInProgress).toBe(false);
    expect(host.fireDataRefresh).toHaveBeenCalledTimes(1);
    expect(waitForMetadataQuietMock).toHaveBeenCalledTimes(1);
    // The inner fn's value is returned unchanged.
    expect(result).toBe(42);
  });

  it("clears the flag and still refreshes once when fn throws", async () => {
    const host = createHost();

    await expect(
      runJobWithBulkWriteFlag(host, async () => {
        expect(host.bulkWriteInProgress).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(host.bulkWriteInProgress).toBe(false);
    expect(host.fireDataRefresh).toHaveBeenCalledTimes(1);
  });

  it("is nesting-safe: an outer-owned flag stays on and no refresh fires", async () => {
    const host = createHost();
    // Simulate an outer scope (e.g. Smart Assign) already owning the flag.
    host.bulkWriteInProgress = true;

    await runJobWithBulkWriteFlag(host, async () => {
      expect(host.bulkWriteInProgress).toBe(true);
    });

    // 3. Inner job must NOT clobber the outer scope: flag still on, no refresh,
    //    and we never wait for the quiet window (the outer scope settles it).
    expect(host.bulkWriteInProgress).toBe(true);
    expect(host.fireDataRefresh).not.toHaveBeenCalled();
    expect(waitForMetadataQuietMock).not.toHaveBeenCalled();
  });
});
