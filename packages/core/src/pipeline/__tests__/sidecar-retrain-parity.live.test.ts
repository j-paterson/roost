/**
 * Gated parity + performance test: sidecar-trained head ↔ TS inference.
 *
 * SKIPPED unless E2E_RUN_LIVE=1.
 *
 * What it proves:
 *   - POST /api/train-heads returns HTTP 200 in < 5 s for ~120 real-vault rows.
 *   - The text head returned by Python can be fed directly into the TS
 *     `softmaxProba` forward pass and correctly classifies held-out real-vault
 *     embeddings at ≥ 85 % agreement with the ground-truth labels.
 *
 * HOW TO RUN
 * ----------
 * Ensure the sidecar is up (points at the dev vault):
 *   E2E_RUN_LIVE=1 npx vitest run packages/core/src/pipeline/__tests__/sidecar-retrain-parity.live.test.ts
 */

// @vitest-environment node
import * as fs from "fs";
import * as http from "http";
import { describe, it, expect } from "vitest";
import { softmaxProba } from "@/pipeline/classifier-head";
import type { ClassifierHead } from "@/pipeline/classifier-head";

// ── Constants ────────────────────────────────────────────────────────────────

const DEV_VAULT_CACHE =
  (process.env.ROOST_DEV_VAULT ?? "/Users/josystem/SynologyDrive/SynologyDrive/ObsidianBookmarks") + "/.roost/cache";
const SIDECAR_URL = "http://127.0.0.1:11435/api/train-heads";
const DIM = 768;
/** Items per category sent to the trainer (80 % train, 20 % holdout of 50). */
const N_PER_CLASS = 50;
const N_TRAIN = 40;
/** Minimum fraction of holdout items correctly classified. */
const MIN_AGREEMENT = 0.85;
/** Max acceptable wall-clock for the POST. */
const MAX_TRAIN_MS = 5_000;

// ── Skip guard ────────────────────────────────────────────────────────────────

describe.skipIf(process.env.E2E_RUN_LIVE !== "1")(
  "sidecar retrain parity (live)",
  () => {
    // ── Helpers ────────────────────────────────────────────────────────────────

    /**
     * Read an embedding-vectors bin file.
     * Format: first newline-delimited line = JSON array of string keys;
     * remaining bytes = raw float32 little-endian, DIM floats per key.
     * Returns { keyIndex: Map<id, index>, rest: Buffer }.
     */
    function readBin(binPath: string): {
      keyIndex: Map<string, number>;
      rest: Buffer;
    } {
      const buf = fs.readFileSync(binPath);
      const newline = buf.indexOf(0x0a); // '\n'
      const keys: string[] = JSON.parse(buf.subarray(0, newline).toString("utf8"));
      const rest = buf.subarray(newline + 1);
      // Salvage prefix to guard against truncated writes
      const maxVecs = Math.floor(rest.length / (DIM * 4));
      const keyIndex = new Map<string, number>();
      for (let i = 0; i < Math.min(keys.length, maxVecs); i++) {
        keyIndex.set(keys[i], i);
      }
      return { keyIndex, rest };
    }

    /** Retrieve a single DIM-length float32 vector from the bin rest-buffer. */
    function getVec(
      id: string,
      keyIndex: Map<string, number>,
      rest: Buffer
    ): number[] | null {
      const idx = keyIndex.get(id);
      if (idx === undefined) return null;
      const offset = idx * DIM * 4;
      const vec = new Array<number>(DIM);
      for (let d = 0; d < DIM; d++) {
        vec[d] = rest.readFloatLE(offset + d * 4);
      }
      return vec;
    }

    /** argmax over a probability array. */
    function argmax(p: number[]): number {
      let best = 0;
      for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
      return best;
    }

    /**
     * POST JSON body to a local http endpoint using Node's built-in http module.
     * Returns { status, body } — avoids happy-dom's cross-origin fetch restrictions.
     */
    function httpPost(
      url: string,
      body: string
    ): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request(
          {
            hostname: u.hostname,
            port: Number(u.port) || 80,
            path: u.pathname,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              })
            );
          }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
    }

    // ── Test ───────────────────────────────────────────────────────────────────

    it(
      "trains heads via sidecar and TS inference agrees ≥ 85% on held-out text vecs",
      async () => {
        // 1. Load training-set.json from dev vault.
        const trainingSetRaw = fs.readFileSync(
          `${DEV_VAULT_CACHE}/training-set.json`,
          "utf8"
        );
        const trainingSet: {
          positives: Record<string, { category: string; ts: number }>;
        } = JSON.parse(trainingSetRaw);
        const positives = trainingSet.positives;

        // 2. Load the text embedding bin (vision bin not needed for this parity check).
        const { keyIndex: textIdx, rest: textRest } = readBin(
          `${DEV_VAULT_CACHE}/embedding-vectors-text.bin`
        );

        // 3. Pick top 3 categories by count (only considering ids present in the bin).
        const catCounts = new Map<string, number>();
        for (const [id, row] of Object.entries(positives)) {
          if (textIdx.has(id)) {
            catCounts.set(row.category, (catCounts.get(row.category) ?? 0) + 1);
          }
        }
        const top3 = [...catCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([cat]) => cat);

        expect(top3.length).toBe(3);

        // 4. Build stable train + holdout splits (sorted ids = deterministic).
        const trainRows: { id: string; category: string }[] = [];
        const holdout: { id: string; category: string }[] = [];

        for (const cat of top3) {
          const ids = Object.entries(positives)
            .filter(([id, row]) => row.category === cat && textIdx.has(id))
            .map(([id]) => id)
            .sort() // deterministic
            .slice(0, N_PER_CLASS);

          for (const id of ids.slice(0, N_TRAIN)) {
            trainRows.push({ id, category: cat });
          }
          for (const id of ids.slice(N_TRAIN, N_PER_CLASS)) {
            holdout.push({ id, category: cat });
          }
        }

        expect(trainRows.length).toBeGreaterThan(0);
        expect(holdout.length).toBeGreaterThan(0);

        // 5. POST to sidecar and measure wall-clock.
        const t0 = Date.now();
        const res = await httpPost(
          SIDECAR_URL,
          JSON.stringify({ rows: trainRows, oofFolds: 3 })
        );
        const elapsedMs = Date.now() - t0;

        expect(res.status, `sidecar returned HTTP ${res.status}`).toBe(200);
        expect(elapsedMs).toBeLessThan(MAX_TRAIN_MS);

        const json = JSON.parse(res.body) as {
          text: {
            classes: string[];
            W: number[][];
            b: number[];
            dim: number;
          };
        };

        expect(Array.isArray(json.text?.classes)).toBe(true);
        expect(json.text.classes.length).toBe(3);

        // 6. Build the ClassifierHead for TS inference.
        const head: ClassifierHead = {
          classes: json.text.classes,
          W: json.text.W,
          b: json.text.b,
          dim: json.text.dim,
        };

        // 7. Run inference on held-out items.
        let correct = 0;
        let evaluated = 0;

        for (const h of holdout) {
          const vec = getVec(h.id, textIdx, textRest);
          if (vec === null) continue; // skip ids that somehow lost a vector
          evaluated++;
          const proba = softmaxProba(vec, head);
          const predicted = head.classes[argmax(proba)];
          if (predicted === h.category) correct++;
        }

        expect(evaluated).toBeGreaterThan(0);

        const agreement = correct / evaluated;

        // Threshold: ≥ 85 %.  Real-world categories (Tech / Lifestyle / Travel)
        // are well-separated in the Qwen text-embedding space so this is
        // comfortably achievable; we keep it at 85 % (not 90 %) to tolerate
        // borderline items near category centroids.
        expect(agreement).toBeGreaterThanOrEqual(MIN_AGREEMENT);

        console.log(
          `[parity] train=${trainRows.length} holdout=${evaluated} ` +
            `agreement=${(agreement * 100).toFixed(1)}% elapsed=${elapsedMs}ms`
        );
      },
      // Individual test timeout — generous to allow slow CI machines.
      15_000
    );
  }
);
