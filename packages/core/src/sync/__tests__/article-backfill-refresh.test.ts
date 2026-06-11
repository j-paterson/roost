// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Break the circular-dependency chain:
//   article-backfill → vault-writer → enrichments → article-backfill
// by stubbing out the heavy transitive modules before the import.
vi.mock("@/sync/vault-writer", () => ({ VaultWriter: class {} }));
vi.mock("@/sync/article-fetcher", () => ({ ArticleFetcher: class {} }));
vi.mock("obsidian", () => ({ Notice: class {} }));

import { refreshArticleNoteBodies } from "../article-backfill";

// Article raw.json fixture that makes getArticleResultFromRaw(raw)?.content_state truthy
function makeArticleRaw(id: string) {
  return {
    rest_id: id,
    article: {
      article_results: {
        result: {
          title: "Test Article",
          content_state: { blocks: [] },
        },
      },
    },
  };
}

// Non-article raw.json (no content_state)
function makeNonArticleRaw(id: string) {
  return {
    rest_id: id,
    legacy: { full_text: "just a tweet" },
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "roost-test-"));
}

function writeArticleDir(xRoot: string, itemId: string, raw: unknown) {
  const dir = path.join(xRoot, `twitter-${itemId}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "raw.json"), JSON.stringify(raw, null, 2));
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("refreshArticleNoteBodies", () => {
  it("resolves only after slow rewrites finish and returns correct counts", async () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);

    const ids = ["111", "222", "333"];
    for (const id of ids) {
      writeArticleDir(tmp, id, makeArticleRaw(id));
    }

    const calls: Array<{ id: string; itemId: string }> = [];
    const writer = {
      rewriteNoteBody: vi.fn(async (record: { id: string; itemId: string }) => {
        calls.push({ id: record.id, itemId: record.itemId });
        // Simulate a slow rewrite
        await new Promise((r) => setTimeout(r, 30));
      }),
    };

    const log = vi.fn();
    const result = await refreshArticleNoteBodies(tmp, writer, log);

    expect(result).toEqual({ refreshed: 3, refreshFailed: 0 });
    expect(writer.rewriteNoteBody).toHaveBeenCalledTimes(3);

    // All three itemIds must have been seen
    const seenItemIds = calls.map((c) => c.itemId).sort();
    expect(seenItemIds).toEqual(["111", "222", "333"]);
    // Records use the twitter: prefix
    for (const call of calls) {
      expect(call.id).toBe(`twitter:${call.itemId}`);
    }
  });

  it("counts failures without throwing and resolves the returned promise", async () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);

    writeArticleDir(tmp, "aaa", makeArticleRaw("aaa"));
    writeArticleDir(tmp, "bbb", makeArticleRaw("bbb"));
    writeArticleDir(tmp, "ccc", makeArticleRaw("ccc"));

    let callCount = 0;
    const writer = {
      rewriteNoteBody: vi.fn(async (record: { itemId: string }) => {
        callCount++;
        if (record.itemId === "bbb") {
          throw new Error("simulated failure");
        }
      }),
    };

    const log = vi.fn();
    // Must resolve (not reject) even with a failure
    const result = await refreshArticleNoteBodies(tmp, writer, log);

    expect(result.refreshed).toBe(2);
    expect(result.refreshFailed).toBe(1);
    expect(callCount).toBe(3);
  });

  it("skips non-article raw.json files (no content_state)", async () => {
    const tmp = makeTmpDir();
    tmpDirs.push(tmp);

    // One article, one non-article
    writeArticleDir(tmp, "art1", makeArticleRaw("art1"));
    writeArticleDir(tmp, "tweet1", makeNonArticleRaw("tweet1"));

    const writer = {
      rewriteNoteBody: vi.fn(async (_record: { itemId: string }) => {}),
    };

    const log = vi.fn();
    const result = await refreshArticleNoteBodies(tmp, writer, log);

    expect(result).toEqual({ refreshed: 1, refreshFailed: 0 });
    expect(writer.rewriteNoteBody).toHaveBeenCalledTimes(1);
    const calledItemId = writer.rewriteNoteBody.mock.calls[0][0].itemId;
    expect(calledItemId).toBe("art1");
  });
});
