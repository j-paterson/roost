import { describe, it, expect } from "vitest";
import { parseRedditAudioBaseUrl } from "@/sync/media-downloader";

describe("parseRedditAudioBaseUrl", () => {
  const mpd = (base: string) => `<MPD><Period><AdaptationSet contentType="audio"><Representation><BaseURL>${base}</BaseURL></Representation></AdaptationSet></Period></MPD>`;
  it("CMAF (2025+)", () => expect(parseRedditAudioBaseUrl(mpd("CMAF_AUDIO_128.mp4"))).toBe("CMAF_AUDIO_128.mp4"));
  it("DASH_AUDIO_n", () => expect(parseRedditAudioBaseUrl(mpd("DASH_AUDIO_64.mp4"))).toBe("DASH_AUDIO_64.mp4"));
  it("legacy DASH_audio.mp4", () => expect(parseRedditAudioBaseUrl(mpd("DASH_audio.mp4"))).toBe("DASH_audio.mp4"));
  it("bare audio", () => expect(parseRedditAudioBaseUrl(mpd("audio"))).toBe("audio"));
  it("no audio track → null", () => expect(parseRedditAudioBaseUrl("<MPD></MPD>")).toBeNull());
});
