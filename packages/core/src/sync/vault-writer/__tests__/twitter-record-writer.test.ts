import { describe, it, expect, vi } from "vitest";
import { TwitterRecordWriter } from "@/sync/vault-writer/twitter-record-writer";
import type { NormalizedRecord } from "@/lib/normalize";

function makeDeps() {
  const writeNote = vi.fn(async () => {});
  const writeSidecar = vi.fn(async () => {});
  const downloadAndSave = vi.fn(async (_fn: unknown, folder: string, name: string) => `${folder}/${name}`);
  return {
    deps: {
      vault: {} as never,
      syncFolder: "Bookmarks",
      log: () => {},
      index: {} as never,
      noteWriter: {
        extractCommon: () => ({
          text: "This paper changed everything https://t.co/attn2017",
          url: "https://twitter.com/researcher/status/1706030762000",
          published: "2023-11-14T22:13:20.000Z",
          itemId: "1706030762000",
          handle: "@researcher",
          username: "researcher",
        }),
        createAuthorNote: async () => "[[researcher]]",
        writeSidecar,
        writeNote,
      } as never,
      mediaDownloader: { downloadAndSave } as never,
      ensuredFolders: new Set<string>(),
    },
    writeNote,
    writeSidecar,
    downloadAndSave,
  };
}

/** Tweet with an external link + native card metadata (title, description, thumbnail). */
const TWEET_WITH_LINK: NormalizedRecord = {
  id: "twitter:1706030762000",
  platform: "twitter",
  itemId: "1706030762000",
  saved_at: "2023-11-14T22:13:20.000Z",
  published_at: "2023-11-14T22:13:20.000Z",
  captured_via: "sync",
  rawData: {
    legacy: {
      full_text: "This paper changed everything https://t.co/attn2017",
      created_at: "Tue Nov 14 22:13:20 +0000 2023",
      entities: {
        urls: [
          {
            url: "https://t.co/attn2017",
            expanded_url: "https://arxiv.org/abs/1706.03762",
          },
        ],
      },
    },
    card: {
      legacy: {
        binding_values: [
          { key: "title", value: { string_value: "Attention Is All You Need" } },
          { key: "description", value: { string_value: "The dominant sequence transduction models." } },
          {
            key: "thumbnail_image_original",
            value: { image_value: { url: "https://arxiv.org/thumb/1706.03762.jpg" } },
          },
        ],
      },
    },
  } as never,
};

/** Plain tweet with no URLs — link_* fields must be absent. */
const TWEET_NO_LINK: NormalizedRecord = {
  id: "twitter:9999000001",
  platform: "twitter",
  itemId: "9999000001",
  saved_at: "2023-11-14T22:13:20.000Z",
  published_at: "2023-11-14T22:13:20.000Z",
  captured_via: "sync",
  rawData: {
    legacy: {
      full_text: "Just a thought with no links.",
      created_at: "Tue Nov 14 22:13:20 +0000 2023",
      entities: { urls: [] },
    },
  } as never,
};

describe("TwitterRecordWriter", () => {
  it("tweet with card link: emits link_url/link_title/link_desc/link_site/link_image frontmatter", async () => {
    const { deps, writeNote, downloadAndSave } = makeDeps();
    await new TwitterRecordWriter(deps).writeTwitterRecord(TWEET_WITH_LINK);

    // The card-thumb download must be triggered
    expect(downloadAndSave).toHaveBeenCalledWith(
      expect.any(Function),
      expect.stringContaining("twitter-1706030762000"),
      "card-thumb.jpg",
    );

    expect(writeNote).toHaveBeenCalled();
    const fm = (writeNote.mock.calls as unknown as unknown[][])[0][2] as string;

    // URL contains ":" → YAML-quoted
    expect(fm).toContain('link_url: "https://arxiv.org/abs/1706.03762"');
    // Plain title — no quoting
    expect(fm).toContain("link_title: Attention Is All You Need");
    // Just check the field is present (description may or may not need quoting)
    expect(fm).toContain("link_desc:");
    expect(fm).toContain("link_site: arxiv.org");
    // Wikilink starts with "[" → YAML-quoted
    expect(fm).toContain('link_image: "[[');
  });

  it("tweet without an external link: emits no link_* frontmatter fields", async () => {
    const { deps, writeNote } = makeDeps();
    await new TwitterRecordWriter(deps).writeTwitterRecord(TWEET_NO_LINK);

    expect(writeNote).toHaveBeenCalled();
    const fm = (writeNote.mock.calls as unknown as unknown[][])[0][2] as string;

    expect(fm).not.toContain("link_url");
    expect(fm).not.toContain("link_title");
    expect(fm).not.toContain("link_image");
  });
});
