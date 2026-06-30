import { describe, it, expect, vi } from "vitest";
import { RedditRecordWriter } from "@/sync/vault-writer/reddit-record-writer";
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
        extractCommon: () => ({ text: "", url: "https://www.reddit.com/r/x/comments/abc/t/", published: "2023-11-14T22:13:20.000Z", itemId: "abc", handle: "jane" }),
        createAuthorNote: async () => "[[jane]]",
        writeSidecar, writeNote,
      } as never,
      mediaDownloader: { downloadAndSave } as never,
      ensuredFolders: new Set<string>(),
      ffmpegPath: undefined,
    },
    writeNote, writeSidecar, downloadAndSave,
  };
}

const IMAGE_REC: NormalizedRecord = {
  id: "reddit:abc", platform: "reddit", itemId: "abc",
  saved_at: "2023-11-14T22:13:20.000Z", published_at: "2023-11-14T22:13:20.000Z", captured_via: "sync",
  rawData: {
    id: "abc", title: "An image post", subreddit: "ObsidianMD", author: "jane",
    post_hint: "image", url: "https://i.redd.it/x.jpg", url_overridden_by_dest: "https://i.redd.it/x.jpg",
    score: 42, num_comments: 7,
  },
};

const SELF_REC: NormalizedRecord = {
  id: "reddit:def", platform: "reddit", itemId: "def",
  saved_at: "2023-11-14T22:13:20.000Z", published_at: "2023-11-14T22:13:20.000Z", captured_via: "sync",
  rawData: { id: "def", title: "A self post", subreddit: "ObsidianMD", author: "jane", is_self: true, selftext: "hello **body**" },
};

const LINK_REC: NormalizedRecord = {
  id: "reddit:lnk", platform: "reddit", itemId: "lnk",
  saved_at: "2023-11-14T22:13:20.000Z", published_at: "2023-11-14T22:13:20.000Z", captured_via: "sync",
  rawData: {
    id: "lnk", title: "Cool article", subreddit: "technology", author: "jane",
    post_hint: "link", url_overridden_by_dest: "https://www.nytimes.com/x.html",
    preview: { images: [{ source: { url: "https://preview.redd.it/p.jpg?width=640&amp;auto=webp" } }] },
  },
};

describe("RedditRecordWriter", () => {
  it("image post: downloads image, writes raw.json + note with subreddit tag/frontmatter", async () => {
    const { deps, writeNote, writeSidecar, downloadAndSave } = makeDeps();
    await new RedditRecordWriter(deps).writeRedditRecord(IMAGE_REC);

    expect(downloadAndSave).toHaveBeenCalled(); // the i.redd.it image
    expect((writeSidecar.mock.calls as unknown[][]).some((c) => String(c[0]).endsWith("raw.json"))).toBe(true);
    expect(writeNote).toHaveBeenCalled();
    const fm = (writeNote.mock.calls as unknown as unknown[][])[0][2] as string;
    expect(fm).toContain("platform: reddit");
    expect(fm).toContain("subreddit/ObsidianMD"); // tag
    expect(fm).toContain("r/ObsidianMD");          // subreddit frontmatter field
  });

  it("self post: no media download, selftext goes in the note body", async () => {
    const { deps, writeNote, downloadAndSave } = makeDeps();
    await new RedditRecordWriter(deps).writeRedditRecord(SELF_REC);

    expect(downloadAndSave).not.toHaveBeenCalled(); // text post has no media
    const bodyParts = (writeNote.mock.calls as unknown as unknown[][])[0][3] as string[];
    expect(bodyParts).toContain("hello **body**");
  });

  it("link post: writes link_url/link_title/link_site/link_image frontmatter", async () => {
    const { deps, writeNote, downloadAndSave } = makeDeps();
    await new RedditRecordWriter(deps).writeRedditRecord(LINK_REC);
    expect(downloadAndSave).toHaveBeenCalled(); // the preview image
    const fm = (writeNote.mock.calls as unknown as unknown[][])[0][2] as string;
    expect(fm).toContain("https://www.nytimes.com/x.html");
    expect(fm).toContain("link_title: Cool article");
    expect(fm).toContain("link_site: nytimes.com");
    expect(fm).toContain("link_image:"); // points at the downloaded cover
  });
});
