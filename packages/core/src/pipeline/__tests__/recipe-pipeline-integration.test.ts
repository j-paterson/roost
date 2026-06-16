import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runRecipePipeline,
  RECIPE_ENRICHMENT,
  FILED_RECIPE_CATEGORIES,
} from "@/pipeline/recipe-pipeline";
import {
  __setRequestUrlImpl,
  __resetRequestUrlImpl,
  App,
  TFile,
  TFolder,
  FileSystemAdapter,
} from "obsidian";

function makeAppWithOne(base: string, roostId: string): App {
  const syncFolder = "Bookmarks";
  const attachDir = path.join(base, syncFolder, "X", "twitter-rec1");
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, "raw.json"), JSON.stringify({
    text: "Pasta carbonara with guanciale and pecorino",
    author: { signature: "" },
  }));

  // Create the source markdown note with a frontmatter block
  const noteContent = `---
roost_id: ${roostId}
title: "Pasta carbonara with guanciale"
subtitle: ""
source: twitter
---

Pasta carbonara recipe video.
`;
  fs.writeFileSync(path.join(attachDir, "twitter-rec1.md"), noteContent);

  const roostDir = path.join(base, ".roost", "cache");
  fs.mkdirSync(roostDir, { recursive: true });
  const txt: Record<string, unknown> = {};
  txt[roostId] = { vision: "bowl of pasta", summary: "", category: "recipe", vec: null };
  fs.writeFileSync(path.join(roostDir, "embedding-cache.json"), JSON.stringify(txt));

  const allKeys = [roostId];
  const VEC_DIM = 768;
  const header = Buffer.from(JSON.stringify(allKeys) + "\n", "utf8");
  const floatBuf = Buffer.alloc(allKeys.length * VEC_DIM * 4, 0);
  fs.writeFileSync(
    path.join(roostDir, "embedding-vectors.bin"),
    Buffer.concat([header, floatBuf])
  );

  const adapter = new FileSystemAdapter();
  adapter.basePath = base;

  const files = new Map<string, string>();
  // Pre-seed the bookmark note
  const relPath = `${syncFolder}/X/twitter-rec1/twitter-rec1.md`;
  files.set(relPath, noteContent);

  const vault = {
    adapter,
    getAbstractFileByPath: (p: string) =>
      files.has(p) ? (Object.assign(new TFile(), { path: p }) as any) : null,
    read: async (f: any) => files.get(f.path) ?? "",
    create: async (p: string, c: string) => {
      files.set(p, c);
      fs.mkdirSync(path.join(base, path.dirname(p)), { recursive: true });
      fs.writeFileSync(path.join(base, p), c);
      const f = new TFile() as TFile & { path: string };
      f.path = p;
      return f;
    },
    modify: async (f: any, c: string) => {
      const p = (f as unknown as { path: string }).path;
      files.set(p, c);
      fs.writeFileSync(path.join(base, p), c);
    },
    createFolder: async (p: string) => {
      fs.mkdirSync(path.join(base, p), { recursive: true });
      const tf = new TFolder() as TFolder & { path: string };
      tf.path = p;
      return tf;
    },
    getMarkdownFiles: () =>
      Array.from(files.keys())
        .filter(p => p.endsWith(".md"))
        .map(p => Object.assign(new TFile(), { path: p })),
  };

  const app = new App() as any;
  app.vault = vault;
  app.metadataCache = {
    getFileCache: (f: any) => {
      const content = files.get(f.path) ?? "";
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return null;
      const fm: Record<string, any> = {};
      for (const line of fmMatch[1].split("\n")) {
        const m = line.match(/^(\w[\w_]*):\s*(.+)$/);
        if (m) fm[m[1]] = m[2].replace(/^"|"$/g, "");
      }
      return { frontmatter: fm };
    },
    getFirstLinkpathDest: () => null,
  };
  return app;
}

describe("runRecipePipeline — integration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-rpipe-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    __resetRequestUrlImpl();
  });

  it("triages a candidate, extracts, and writes recipe_* fields onto the source bookmark", async () => {
    const app = makeAppWithOne(tmp, "twitter:rec1");
    let call = 0;
    __setRequestUrlImpl(async req => {
      call++;
      const body = req.body ? JSON.parse(req.body) : {};
      if (body?.options?.num_predict <= 10) {
        return { status: 200, json: { response: "recipe" }, text: "" };
      }
      return {
        status: 200,
        json: { response: JSON.stringify({
          dish: "Carbonara", cuisine: "Italian",
          ingredients: [{ item: "pasta", qty: "200g" }, { item: "guanciale", qty: "100g" }],
          steps: ["boil", "toss"], prepTime: null, cookTime: "15m",
          difficulty: "medium", notes: null,
        }) },
        text: "",
      };
    });

    const result = await runRecipePipeline(app, "Bookmarks");

    expect(call).toBeGreaterThanOrEqual(2);
    expect(result.candidates).toBe(1);
    expect(result.recipes).toBe(1);
    expect(result.errors).toBe(0);

    // No synthesized note under Pipelines/Recipes/
    const pipelineNote = path.join(tmp, "Pipelines", "Recipes", "Carbonara.md");
    expect(fs.existsSync(pipelineNote)).toBe(false);

    // Source bookmark gained recipe_* fields
    const sourceFile = (app as any).vault.getMarkdownFiles()
      .find((f: any) => f.path.includes("twitter-rec1"));
    expect(sourceFile).toBeDefined();
    const fm = (app as any).metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
    expect(fm.recipe_dish).toBe("Carbonara");
    expect(fm.recipe_cuisine).toBe("Italian");
    expect(fm.enrichment_v_recipe).toBe("1");

    const cache = JSON.parse(fs.readFileSync(path.join(tmp, ".roost", "cache", "recipe-cache.json"), "utf8"));
    expect(cache["twitter:rec1"].triage).toBe("recipe");
    // Slim cache: extraction payload is NOT stored; extracted flag is set instead.
    expect(cache["twitter:rec1"].extracted).toBe(true);
    expect(cache["twitter:rec1"].extraction).toBeNull();
  });
});

describe("recipe filed-category single source of truth", () => {
  it("keeps the gather gate (FILED_RECIPE_CATEGORIES) and RECIPE_ENRICHMENT.categoryMatches in sync", () => {
    // The gather gate compares lowercased filed categories; the registry uses the
    // original-cased display values. They must describe the same set, otherwise the
    // candidate-gather gate and UI/settings gating silently desync.
    const fromGate = [...FILED_RECIPE_CATEGORIES].sort();
    const fromRegistry = (RECIPE_ENRICHMENT.categoryMatches ?? [])
      .map(c => c.toLowerCase())
      .sort();
    expect(fromRegistry).toEqual(fromGate);
  });
});
