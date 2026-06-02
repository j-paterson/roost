/**
 * Inline audio players for music rows in the Media list.
 *
 *   - Spotify iframe embeds are mounted directly by media-list.ts
 *     and self-coordinate within Spotify's auth session.
 *   - TikTok / X cached-video rows get our own Spotify-styled card
 *     player (artwork + title + scrubber + play button, ~152px tall)
 *     mounted by mountTikTokMusicPlayer below.
 *
 * All TikTok players share a "pause-others-when-one-plays" invariant
 * via the allActivePlayers Set — multiple players coexist; only one
 * is audible.
 */

interface ActivePlayer {
  /** Pause this player's audio without tearing down the UI. Called
   *  when another player starts playing (one-at-a-time semantics). */
  pause: () => void;
  /** Full teardown — remove DOM, drop event listeners. Called on
   *  view tear-down / plugin unload. */
  destroy: () => void;
}

const allActivePlayers = new Set<ActivePlayer>();

function pauseOtherPlayers(except: ActivePlayer): void {
  for (const p of allActivePlayers) {
    if (p !== except) p.pause();
  }
}

export function stopAllInlinePlayers(): void {
  for (const p of allActivePlayers) p.destroy();
  allActivePlayers.clear();
}

/** Tear down all module-scope state. Called on plugin unload. */
export function teardownInlinePlayer(): void {
  stopAllInlinePlayers();
}

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface InlinePlayerHandle {
  destroy: () => void;
}

export interface TikTokMusicPlayerOptions {
  videoUrl: string;
  title: string;
  creator: string;
  coverUrl: string | null;
}

/** Mount a Spotify-styled card player for a cached source video.
 *  The video element uses preload="none" so the file isn't fetched
 *  until the user clicks ▶ — auto-mounted players are cheap. */
export function mountTikTokMusicPlayer(
  container: HTMLElement,
  opts: TikTokMusicPlayerOptions,
): InlinePlayerHandle {
  container.empty();
  container.addClass("roost-tt-music-player");

  if (opts.coverUrl) {
    const art = container.createEl("img", { cls: "roost-tt-music-player-art" });
    art.src = opts.coverUrl;
    art.alt = "";
  } else {
    container.createDiv({ cls: "roost-tt-music-player-art roost-tt-music-player-art--empty" });
  }

  const body = container.createDiv({ cls: "roost-tt-music-player-body" });
  body.createDiv({ cls: "roost-tt-music-player-title", text: opts.title || "Untitled" });
  body.createDiv({ cls: "roost-tt-music-player-creator", text: opts.creator || "Unknown" });

  const controls = body.createDiv({ cls: "roost-tt-music-player-controls" });
  const playBtn = controls.createEl("button", {
    cls: "roost-tt-music-player-playbtn",
    text: "▶",
  });
  playBtn.setAttr("title", "Play / pause");

  const scrubber = controls.createEl("input", { cls: "roost-tt-music-player-scrubber" });
  scrubber.type = "range";
  scrubber.min = "0";
  scrubber.max = "1000";
  scrubber.value = "0";
  scrubber.disabled = true;

  const timeEl = controls.createDiv({ cls: "roost-tt-music-player-time", text: "0:00" });

  scrubber.addEventListener("mousedown", (e) => e.stopPropagation());
  scrubber.addEventListener("click", (e) => e.stopPropagation());
  scrubber.addEventListener("input", (e) => e.stopPropagation());

  // Hidden <video>. preload="none" keeps the file off the network
  // until the user actually clicks play, so auto-mounting hundreds
  // of these is cheap.
  const video = document.createElement("video");
  video.src = opts.videoUrl;
  video.preload = "none";
  video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none";
  document.body.appendChild(video);

  let destroyed = false;
  let scrubbing = false;

  video.addEventListener("loadedmetadata", () => {
    if (destroyed) return;
    scrubber.disabled = false;
    timeEl.setText(`0:00 / ${fmtTime(video.duration)}`);
  });
  video.addEventListener("timeupdate", () => {
    if (destroyed || scrubbing) return;
    if (video.duration > 0) {
      scrubber.value = String(Math.round((video.currentTime / video.duration) * 1000));
      timeEl.setText(`${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`);
    }
  });
  video.addEventListener("ended", () => { if (!destroyed) playBtn.setText("▶"); });
  video.addEventListener("pause", () => { if (!destroyed) playBtn.setText("▶"); });
  video.addEventListener("play", () => { if (!destroyed) playBtn.setText("⏸"); });
  video.addEventListener("error", () => {
    if (!destroyed) timeEl.setText("(can't load source)");
  });

  const handle: ActivePlayer & InlinePlayerHandle = {
    pause: () => { try { video.pause(); } catch { /* already gone */ } },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      try { video.pause(); } catch { /* already gone */ }
      video.remove();
      container.removeClass("roost-tt-music-player");
      allActivePlayers.delete(handle);
    },
  };
  allActivePlayers.add(handle);

  playBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (video.paused) {
      pauseOtherPlayers(handle);
      void video.play().catch(() => { playBtn.setText("▶"); });
    } else {
      video.pause();
    }
  });

  scrubber.addEventListener("change", () => {
    scrubbing = false;
    if (video.duration > 0) {
      video.currentTime = (Number(scrubber.value) / 1000) * video.duration;
    }
  });
  scrubber.addEventListener("mousedown", () => { scrubbing = true; });

  return handle;
}
