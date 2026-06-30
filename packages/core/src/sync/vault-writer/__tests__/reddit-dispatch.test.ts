// packages/core/src/sync/vault-writer/__tests__/reddit-dispatch.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { RedditRecordWriter } from "@/sync/vault-writer/reddit-record-writer";
import { VaultWriter } from "@/sync/vault-writer";
import type { NormalizedRecord } from "@/lib/normalize";

// Smoke test: a reddit record routes to the RedditRecordWriter, not the
// generic note writer.
describe("VaultWriter reddit dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writeBatch routes reddit records to writeRedditRecord", async () => {
    // Spy on the prototype before construction so all instances are covered.
    // Using the prototype seam avoids brittle private-field casting while still
    // verifying that VaultWriter's writeBatch actually delegates to the writer.
    const spy = vi
      .spyOn(RedditRecordWriter.prototype, "writeRedditRecord")
      .mockResolvedValue(undefined);

    const vault = { adapter: { exists: async () => false } } as never;
    const writer = new VaultWriter({
      vault,
      syncFolder: "Roost",
    });

    // Pre-seed existingIds so writeBatch skips the scanExistingIds call.
    (
      writer as unknown as {
        index: { existingIds: Set<string> };
      }
    ).index.existingIds = new Set();

    const record: NormalizedRecord = {
      id: "reddit:abc",
      platform: "reddit",
      itemId: "abc",
      rawData: {},
      saved_at: "",
      published_at: null,
      captured_via: "sync",
    };

    await writer.writeBatch([record]);
    expect(spy).toHaveBeenCalledWith(record);
  });
});
