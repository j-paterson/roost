/**
 * In-page page-fetchers for the folder backfill, run via `webContents.executeJavaScript`.
 *
 * DOM scrolling does NOT paginate X bookmark-folder timelines (verified via the live
 * e2e — the second page is never fetched on scroll). The only reliable way past the
 * first ~20 is GraphQL cursor replay: re-issue the real BookmarkFoldersSlice /
 * BookmarkFolderTimeline request the page already made (captured by the probe as
 * `bookmarkFoldersSliceReplay` / `bookmarkFolderTimelineReplay`), swapping in the
 * folder id + bottom cursor.
 *
 * Each builder returns a script that fetches exactly ONE page and returns it as JSON.
 * The CALLER loops in Node (one executeJavaScript per page) — a single giant in-page
 * loop overruns the WebDriver script timeout and gives no progress/resilience.
 *
 * Prereq: the probe must have captured the relevant replay template — load the
 * bookmarks page (slice) and navigate to one folder (timeline) first.
 */

/** One page of the folder LIST. Returns JSON `{ folders: {id:name}, nextCursor }` or `{ error }`. */
export function folderListPageScript(cursor: string | null): string {
  return `
(async function(){
  var s = window.__TWITTER_BOOKMARK_SPIKE__ || {};
  var r = s.bookmarkFoldersSliceReplay;
  if (!r) return JSON.stringify({error:"no folder-list replay captured"});
  var u = new URL(r.url, location.origin); var v = {}; try { v = JSON.parse(u.searchParams.get("variables")||"{}"); } catch(e){}
  v.count = 100; ${cursor ? `v.cursor = ${JSON.stringify(cursor)};` : `delete v.cursor;`}
  u.searchParams.set("variables", JSON.stringify(v));
  var h = {}; for (var k in (r.headers||{})) h[k] = r.headers[k];
  var resp; try { resp = await fetch(u.toString(), {method:"GET", headers:h, credentials:"include"}); } catch(e){ return JSON.stringify({error:"fetch "+e}); }
  if (!resp.ok) return JSON.stringify({error:"http "+resp.status});
  var data = await resp.json();
  var slice = data&&data.data&&data.data.viewer&&data.data.viewer.user_results&&data.data.viewer.user_results.result&&data.data.viewer.user_results.result.bookmark_collections_slice;
  if (!slice) return JSON.stringify({error:"no slice in response"});
  var folders = {}; var items = slice.items||[];
  for (var i=0;i<items.length;i++){ var it=items[i]; var id=it.id||it.rest_id; if(id) folders[id]=it.name; }
  var nc = (slice.slice_info&&(slice.slice_info.next_cursor||slice.slice_info.cursor))||slice.next_cursor||null;
  return JSON.stringify({ folders: folders, nextCursor: nc });
})()
`;
}

/** One page of a folder's TIMELINE. Returns JSON `{ ids:[...], nextCursor }` or `{ error }`. */
export function folderTimelinePageScript(folderId: string, cursor: string | null): string {
  return `
(async function(){
  var s = window.__TWITTER_BOOKMARK_SPIKE__ || {};
  var r = s.bookmarkFolderTimelineReplay;
  if (!r) return JSON.stringify({error:"no folder-timeline replay captured"});
  var u = new URL(r.url, location.origin); var v = {}; try { v = JSON.parse(u.searchParams.get("variables")||"{}"); } catch(e){}
  v.bookmark_collection_id = ${JSON.stringify(folderId)}; v.count = 100; ${cursor ? `v.cursor = ${JSON.stringify(cursor)};` : `delete v.cursor;`}
  u.searchParams.set("variables", JSON.stringify(v));
  var h = {}; for (var k in (r.headers||{})) h[k] = r.headers[k];
  var resp; try { resp = await fetch(u.toString(), {method:"GET", headers:h, credentials:"include"}); } catch(e){ return JSON.stringify({error:"fetch "+e}); }
  if (!resp.ok) return JSON.stringify({error:"http "+resp.status});
  var data = await resp.json();
  var tl = data&&data.data&&data.data.bookmark_collection_timeline&&data.data.bookmark_collection_timeline.timeline;
  var instr = (tl&&tl.instructions)||[];
  var ids = [], bottom = null;
  for (var i=0;i<instr.length;i++){ var es=instr[i].entries||[]; for (var j=0;j<es.length;j++){ var c=es[j].content||{};
    if (c.entryType==="TimelineTimelineCursor"&&c.cursorType==="Bottom") bottom=c.value;
    var tr=c.itemContent&&c.itemContent.tweet_results&&c.itemContent.tweet_results.result;
    var id=tr&&(tr.rest_id||(tr.tweet&&tr.tweet.rest_id)); if(id) ids.push(id);
  } }
  return JSON.stringify({ ids: ids, nextCursor: bottom });
})()
`;
}
