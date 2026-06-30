// packages/core/src/sync/vault-writer/__tests__/instagram-dispatch.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramRecordWriter } from "@/sync/vault-writer/instagram-record-writer";
import { VaultWriter } from "@/sync/vault-writer";
import type { NormalizedRecord } from "@/lib/normalize";

// Smoke test: an instagram record routes to the InstagramRecordWriter, not the
// generic note writer.
describe("VaultWriter instagram dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writeBatch routes instagram records to writeInstagramRecord", async () => {
    // Spy on the prototype before construction so all instances are covered.
    // Using the prototype seam avoids brittle private-field casting while still
    // verifying that VaultWriter's writeBatch actually delegates to the writer.
    const spy = vi
      .spyOn(InstagramRecordWriter.prototype, "writeInstagramRecord")
      .mockResolvedValue(undefined);

    const vault = { adapter: { exists: async () => false } } as never;
    const writer = new VaultWriter({
      vault,
      syncFolder: "Roost",
      instagramWebview: {
        executeJavaScript: async () => "data:image/jpeg;base64,QUJD",
      } as never,
    });

    // Pre-seed existingIds so writeBatch skips the scanExistingIds call.
    (
      writer as unknown as {
        index: { existingIds: Set<string> };
      }
    ).index.existingIds = new Set();

    const record: NormalizedRecord = {
      id: "instagram:X",
      platform: "instagram",
      itemId: "X",
      rawData: { code: "X" },
      saved_at: "",
      published_at: null,
      captured_via: "sync",
    };

    await writer.writeBatch([record]);
    expect(spy).toHaveBeenCalledWith(record);
  });
});
