import { describe, it, expect } from "vitest";
import { buildTweetThreadView } from "@/views/tweet-view-model";
import type { RawApiData } from "@/lib/normalize";

/** Minimal raw tweet shape (mirrors extract.ts: text under legacy.full_text,
 *  author under core.user_results.result.core.screen_name). */
function rawTweet(opts: {
  restId: string;
  handle: string;
  text: string;
  createdAt?: string;
  replyTo?: string;
  quoted?: { handle: string; text: string };
  thread?: RawApiData[];
  quotedThread?: RawApiData[];
}): RawApiData {
  const raw: Record<string, unknown> = {
    rest_id: opts.restId,
    core: { user_results: { result: { core: { name: opts.handle, screen_name: opts.handle } } } },
    legacy: {
      full_text: opts.text,
      created_at: opts.createdAt,
      in_reply_to_screen_name: opts.replyTo,
    },
  };
  if (opts.quoted) {
    raw.quoted_status_result = {
      result: {
        rest_id: `${opts.restId}-q`,
        core: { user_results: { result: { core: { screen_name: opts.quoted.handle } } } },
        legacy: { full_text: opts.quoted.text },
      },
    };
  }
  if (opts.thread) raw._thread = opts.thread.map((r) => ({ rest_id: r.rest_id, raw: r }));
  if (opts.quotedThread) raw._quoted_thread = opts.quotedThread.map((r) => ({ rest_id: r.rest_id, raw: r }));
  return raw as RawApiData;
}

describe("buildTweetThreadView", () => {
  it("non-threaded tweet → single focal segment with clean text + author", () => {
    const view = buildTweetThreadView(
      rawTweet({ restId: "1", handle: "levelsio", text: "shipped it" }),
    );
    expect(view.segments).toHaveLength(1);
    expect(view.quotedThread).toHaveLength(0);
    const seg = view.segments[0];
    expect(seg.isFocal).toBe(true);
    expect(seg.author).toBe("levelsio");
    expect(seg.text).toBe("shipped it");
    expect(seg.quoted).toBeNull();
    expect(seg.replyTo).toBeNull();
  });

  it("captures a quoted tweet as structured author + text", () => {
    const view = buildTweetThreadView(
      rawTweet({
        restId: "1",
        handle: "levelsio",
        text: "this 👇",
        quoted: { handle: "swyx", text: "this is the way" },
      }),
    );
    expect(view.segments[0].quoted).toEqual({ author: "swyx", text: "this is the way" });
  });

  it("surfaces an external reply-to but suppresses a self-reply", () => {
    const external = buildTweetThreadView(
      rawTweet({ restId: "1", handle: "levelsio", text: "agreed", replyTo: "swyx" }),
    );
    expect(external.segments[0].replyTo).toBe("swyx");

    const selfReply = buildTweetThreadView(
      rawTweet({ restId: "1", handle: "levelsio", text: "more", replyTo: "levelsio" }),
    );
    expect(selfReply.segments[0].replyTo).toBeNull();
  });

  it("expands a thread into one segment per _thread entry, flagging the focal", () => {
    const focal = rawTweet({ restId: "1", handle: "levelsio", text: "first" });
    const reply = rawTweet({ restId: "2", handle: "levelsio", text: "second" });
    const view = buildTweetThreadView(
      rawTweet({ restId: "1", handle: "levelsio", text: "first", thread: [focal, reply] }),
    );
    expect(view.segments.map((s) => s.text)).toEqual(["first", "second"]);
    expect(view.segments.map((s) => s.isFocal)).toEqual([true, false]);
  });
});
