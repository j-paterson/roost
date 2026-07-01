// packages/core/src/sync/vault-writer/__tests__/instagram-record-writer.test.ts
import { describe, it, expect, vi } from "vitest";
import { InstagramRecordWriter } from "@/sync/vault-writer/instagram-record-writer";
import type { NormalizedRecord } from "@/lib/normalize";

function makeDeps() {
  const writeNote = vi.fn(async () => {});
  const writeSidecar = vi.fn(async () => {});
  const downloadAndSave = vi.fn(async (_fn: unknown, folder: string, name: string) => `${folder}/${name}`);
  return {
    deps: {
      vault: {} as never,
      syncFolder: "Roost",
      log: () => {},
      index: {} as never,
      noteWriter: {
        extractCommon: () => ({ text: "cap", url: "https://www.instagram.com/p/X/", published: "2023-11-14T22:13:20.000Z", itemId: "X", handle: "u" }),
        createAuthorNote: async () => "[[u]]",
        writeSidecar, writeNote,
      } as never,
      mediaDownloader: { downloadAndSave } as never,
      ensuredFolders: new Set<string>(),
      instagramWc: { executeJavaScript: async () => "data:image/jpeg;base64,QUJD" } as never,
    },
    writeNote, writeSidecar, downloadAndSave,
  };
}

const REC: NormalizedRecord = {
  id: "instagram:X", platform: "instagram", itemId: "X",
  saved_at: "2023-11-14T22:13:20.000Z", published_at: "2023-11-14T22:13:20.000Z", captured_via: "sync",
  rawData: {
    code: "X", media_type: 1, user: { username: "u", full_name: "U" },
    caption: { text: "cap" }, like_count: 3, comment_count: 1,
    image_versions2: { candidates: [{ url: "https://cdn/i.jpg" }] },
    _roost_collections: ["Recipes"],
  },
};

describe("InstagramRecordWriter", () => {
  it("downloads the image, writes raw.json sidecar + note with collection tags", async () => {
    const { deps, writeNote, writeSidecar, downloadAndSave } = makeDeps();
    const w = new InstagramRecordWriter(deps);
    await w.writeInstagramRecord(REC);

    expect(downloadAndSave).toHaveBeenCalled(); // image fetched during sync
    // raw.json sidecar written
    expect((writeSidecar.mock.calls as unknown[][]).some((c) => String(c[0]).endsWith("raw.json"))).toBe(true);
    // note written; frontmatter contains the collection tag
    expect(writeNote).toHaveBeenCalled();
    const fm = (writeNote.mock.calls as unknown as unknown[][])[0][2] as string;
    expect(fm).toContain("collection/Recipes");
    expect(fm).toContain("platform: instagram");
  });

  it("skips a content-less note when media download fails (expired URL) and there's no caption", async () => {
    const writeNote = vi.fn(async () => {});
    const writeSidecar = vi.fn(async () => {});
    const downloadAndSave = vi.fn(async () => null); // 410 / expired → nothing saved
    const deps = {
      vault: {} as never,
      syncFolder: "Roost",
      log: () => {},
      index: {} as never,
      noteWriter: {
        extractCommon: () => ({ text: "", url: "https://www.instagram.com/p/X/", published: "2021-02-11T00:00:00.000Z", itemId: "X", handle: "u" }),
        createAuthorNote: async () => "[[u]]",
        writeSidecar, writeNote,
      } as never,
      mediaDownloader: { downloadAndSave } as never,
      ensuredFolders: new Set<string>(),
      instagramWc: { executeJavaScript: async () => null } as never,
    };
    const w = new InstagramRecordWriter(deps);
    await w.writeInstagramRecord(REC);

    expect(downloadAndSave).toHaveBeenCalled();     // download was attempted
    expect(writeNote).not.toHaveBeenCalled();       // but no content-less note written
    expect(writeSidecar).not.toHaveBeenCalled();    // and no raw.json-only folder left behind
  });

  it("still writes when a webview is absent (transient) so the item is retried later", async () => {
    const writeNote = vi.fn(async () => {});
    const writeSidecar = vi.fn(async () => {});
    const downloadAndSave = vi.fn(async () => null);
    const deps = {
      vault: {} as never,
      syncFolder: "Roost",
      log: () => {},
      index: {} as never,
      noteWriter: {
        extractCommon: () => ({ text: "", url: "https://www.instagram.com/p/X/", published: "2021-02-11T00:00:00.000Z", itemId: "X", handle: "u" }),
        createAuthorNote: async () => "[[u]]",
        writeSidecar, writeNote,
      } as never,
      mediaDownloader: { downloadAndSave } as never,
      ensuredFolders: new Set<string>(),
      instagramWc: undefined,
    };
    const w = new InstagramRecordWriter(deps);
    await w.writeInstagramRecord(REC);

    expect(writeNote).toHaveBeenCalled(); // no wc → keep the note, retry media later
  });
});
