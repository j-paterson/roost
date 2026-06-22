/**
 * Task 2: qwen cover-only vision describe
 *
 * Asserts that Stage 1a of the embedding pipeline:
 * 1. Calls /api/generate with model = VISION_MODEL, options.num_ctx = VISION_NUM_CTX,
 *    exactly one image, and the new prompt.
 * 2. Stores entry.vision = response.trim().slice(0, 500).
 * 3. For an item with mp4Path + cover, takes the single-cover path (no ffmpeg).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TFile, Vault, __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { VISION_MODEL, VISION_NUM_CTX } from "@/config";

// ── Captured call state ──
let lastUrl: string | null = null;
let lastBody: Record<string, unknown> | null = null;

// ── Fake vault helpers ──
const FAKE_BASE64 = "aW1hZ2VkYXRh"; // base64 of "imagedata"
const FAKE_IMAGE_BYTES = Buffer.from("imagedata");

function makeFakeVault(coverPath: string): Vault {
  const v = new Vault() as Vault & {
    getAbstractFileByPath: (p: string) => TFile | null;
    readBinary: (f: TFile) => Promise<ArrayBuffer>;
  };
  v.getAbstractFileByPath = (p: string) => {
    if (p === coverPath) {
      const f = new TFile() as TFile & { extension: string; path: string };
      f.extension = "jpg";
      f.path = p;
      return f;
    }
    return null;
  };
  v.readBinary = async (_f: TFile) => {
    return FAKE_IMAGE_BYTES.buffer as ArrayBuffer;
  };
  return v;
}

// ── Fake embedder (always returns a vector so the item can complete Stage 2) ──
const fakeEmbedder = {
  embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
};

// ── Fake shared cache helpers ──
vi.mock("@/pipeline/shared", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/pipeline/shared")>();
  return {
    ...real,
    loadEmbeddingCache: vi.fn(() => ({})),
    saveEmbeddingCache: vi.fn(() => {}),
  };
});

// ── Fake vault-utils (getSyncFiles, vaultBasePath) ──
vi.mock("@/lib/vault-utils", () => ({
  getSyncFiles: (vault: Vault, _folder: string) => {
    // Return a single fake TFile from the vault
    return (vault as any).__fakeFiles ?? [];
  },
  vaultBasePath: () => "/fake/vault",
}));

// We also need to mock child_process so no real ffmpeg is invoked even if
// somehow a code path tries to call it.
vi.mock("child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("child_process")>();
  return {
    ...real,
    execFileSync: vi.fn(() => {
      throw new Error("execFileSync should not be called in vision tests");
    }),
  };
});

// ── Fake fs (readdirSync needs to not throw) ──
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return {
    ...real,
    readdirSync: vi.fn((_dirPath: string) => {
      // Return empty list by default — no mp4 files in the fake vault
      return [];
    }),
    readFileSync: real.readFileSync,
    existsSync: real.existsSync,
    statSync: real.statSync,
    mkdtempSync: real.mkdtempSync,
    rmSync: real.rmSync,
  };
});

import { describeItems } from "@/pipeline/describe-items";

// ── App stub that returns frontmatter for our fake file ──
function makeApp(fileStub: TFile, frontmatter: Record<string, unknown>) {
  return {
    metadataCache: {
      getFileCache: (f: TFile) => {
        if (f === fileStub) return { frontmatter };
        return null;
      },
    },
  };
}

describe("Stage 1a: qwen cover-only vision describe", () => {
  beforeEach(() => {
    lastUrl = null;
    lastBody = null;
    __setRequestUrlImpl(async (req) => {
      const body = req.body ? JSON.parse(req.body) : null;
      // Only capture the vision call (model = VISION_MODEL); ignore topic/embed calls
      if (body?.model === VISION_MODEL) {
        lastUrl = req.url;
        lastBody = body;
      }
      // Return a vision response for vision calls, topic response for topic calls
      if (body?.model === VISION_MODEL) {
        return {
          status: 200,
          json: { response: "  A skateboarder performs a kickflip over a set of stairs.  " },
          text: "",
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
        };
      }
      // Topic/category model stub
      return {
        status: 200,
        json: { response: "Topic: a skateboarder\nCategory: Sports" },
        text: "",
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      };
    });
  });

  afterEach(() => {
    __resetRequestUrlImpl();
    vi.clearAllMocks();
  });

  it("calls qwen with VISION_MODEL, VISION_NUM_CTX, exactly one image, and the specified prompt", async () => {
    const coverPath = "Bookmarks/.attachments/item1/cover.jpg";
    const vault = makeFakeVault(coverPath);

    // Create a fake TFile and wire it into the vault
    const fakeFile = new TFile() as TFile & { path: string };
    fakeFile.path = "Bookmarks/item1.md";
    (vault as any).__fakeFiles = [fakeFile];

    const app = makeApp(fakeFile, {
      roost_id: "test:1",
      title: "Cool Skate Video",
      cover: coverPath,
    });

    await describeItems({
      vault,
      app: app as any,
      syncFolder: "Bookmarks",
      ollamaUrl: "http://localhost:11434",
      embedder: fakeEmbedder as any,
    });

    expect(lastUrl).toBe("http://localhost:11434/api/generate");
    expect(lastBody).not.toBeNull();
    expect(lastBody!.model).toBe(VISION_MODEL);
    expect((lastBody!.options as Record<string, unknown>).num_ctx).toBe(VISION_NUM_CTX);
    expect(Array.isArray(lastBody!.images)).toBe(true);
    expect((lastBody!.images as unknown[]).length).toBe(1);
    expect(lastBody!.prompt).toBe("Describe what is happening in this image in two or three sentences.");
  });

  it("stores entry.vision as response.trim().slice(0, 500)", async () => {
    // We need to inspect the cache entry. We'll capture it via a custom saveEmbeddingCache spy.
    let savedCache: Record<string, { vision: string | null }> = {};

    const { saveEmbeddingCache } = await import("@/pipeline/shared");
    (saveEmbeddingCache as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_vault: Vault, cache: Record<string, { vision: string | null }>) => {
        savedCache = cache;
      }
    );

    const coverPath = "Bookmarks/.attachments/item2/cover.jpg";
    const vault = makeFakeVault(coverPath);
    const fakeFile = new TFile() as TFile & { path: string };
    fakeFile.path = "Bookmarks/item2.md";
    (vault as any).__fakeFiles = [fakeFile];

    const app = makeApp(fakeFile, {
      roost_id: "test:2",
      title: "Skate clip",
      cover: coverPath,
    });

    await describeItems({
      vault,
      app: app as any,
      syncFolder: "Bookmarks",
      ollamaUrl: "http://localhost:11434",
      embedder: fakeEmbedder as any,
    });

    const vision = savedCache["test:2"]?.vision;
    expect(vision).toBe("A skateboarder performs a kickflip over a set of stairs.");
  });

  it("takes the single-cover path even when mp4Path is present (no ffmpeg)", async () => {
    // Mock fs.readdirSync to return an mp4 so mp4Path gets set
    const { readdirSync } = await import("fs");
    (readdirSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ["video.mp4"]);

    // Also spy on execFileSync to assert it is never called
    const childProcess = await import("child_process");
    const execSpy = vi.spyOn(childProcess, "execFileSync");

    const coverPath = "Bookmarks/.attachments/item3/cover.jpg";
    const vault = makeFakeVault(coverPath);
    const fakeFile = new TFile() as TFile & { path: string };
    fakeFile.path = "Bookmarks/item3.md";
    (vault as any).__fakeFiles = [fakeFile];

    const app = makeApp(fakeFile, {
      roost_id: "test:3",
      title: "Video with cover",
      cover: coverPath,
    });

    await describeItems({
      vault,
      app: app as any,
      syncFolder: "Bookmarks",
      ollamaUrl: "http://localhost:11434",
      embedder: fakeEmbedder as any,
      ffmpeg: { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" },
    });

    // The vision call should still happen (cover path taken)
    expect(lastBody).not.toBeNull();
    expect(lastBody!.model).toBe(VISION_MODEL);
    expect((lastBody!.images as unknown[]).length).toBe(1);

    // ffmpeg must never be invoked
    expect(execSpy).not.toHaveBeenCalled();
  });
});
