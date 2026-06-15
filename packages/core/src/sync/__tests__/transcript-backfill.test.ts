/**
 * Unit tests for the two pure pieces of transcript-backfill: the attach-folder
 * candidacy check (isTranscriptCandidate) and the /transcribe response decision
 * (decideTranscript), plus registration in the enrichment registry.
 *
 * Following the media-backfill precedent, only the extracted pure helpers are
 * exercised here — the heavy parts of runTranscriptBackfill (walkDir, the
 * sidecar HTTP calls, vault writes) are not driven.
 */
import { describe, it, expect } from "vitest";
import { isTranscriptCandidate, decideTranscript } from "../transcript-backfill";
import { getEnrichmentById } from "@/lib/enrichments";

describe("isTranscriptCandidate", () => {
  it("true when the folder has video.mp4 but no subtitle.vtt", () => {
    expect(isTranscriptCandidate(new Set(["video.mp4"]))).toBe(true);
  });

  it("false when the folder already has a subtitle.vtt caption track", () => {
    expect(isTranscriptCandidate(new Set(["video.mp4", "subtitle.vtt"]))).toBe(false);
  });

  it("false when there is no video at all", () => {
    expect(isTranscriptCandidate(new Set(["raw.json"]))).toBe(false);
  });

  it("true when other media (cover.jpg) sits alongside the video", () => {
    expect(isTranscriptCandidate(new Set(["cover.jpg", "video.mp4"]))).toBe(true);
  });
});

describe("decideTranscript", () => {
  it("'write' for real speech with text + vtt", () => {
    expect(decideTranscript({ text: "hi", vtt: "WEBVTT...", no_speech: false })).toBe("write");
  });

  it("'skip-nospeech' when the sidecar reports no_speech and empty text", () => {
    expect(decideTranscript({ text: "", no_speech: true })).toBe("skip-nospeech");
  });

  it("'skip-nospeech' when text is whitespace-only even with a vtt", () => {
    expect(decideTranscript({ text: "  ", vtt: "WEBVTT" })).toBe("skip-nospeech");
  });

  it("'skip-nospeech' when there is text but no vtt", () => {
    expect(decideTranscript({ text: "hi", no_speech: false })).toBe("skip-nospeech");
  });
});

describe("transcript enrichment registration", () => {
  it("is registered with the expected command id and schema version", () => {
    const def = getEnrichmentById("transcript");
    expect(def).toBeDefined();
    expect(def?.commandId).toBe("backfill-transcripts");
    expect(def?.schemaVersion).toBe(1);
  });
});
