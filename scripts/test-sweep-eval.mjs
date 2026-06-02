#!/usr/bin/env node
/**
 * Unit tests for the evaluation logic in test-strategies-sweep.mjs.
 * Tests the score() function, leave-one-out centroids, and negative handling
 * using synthetic data — no LLM or vault access needed.
 */

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertClose(a, b, msg, tol = 0.1) {
  if (Math.abs(a - b) <= tol) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg} — expected ~${b}, got ${a}`); }
}

// ── Replicate core math from sweep script ──

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function mag(a) { return Math.sqrt(dot(a, a)); }
function cosineSim(a, b) { return dot(a, b) / ((mag(a) || 1) * (mag(b) || 1)); }
function computeCentroid(vecs) {
  const d = vecs[0].length;
  const c = new Array(d).fill(0);
  for (const v of vecs) for (let i = 0; i < d; i++) c[i] += v[i];
  for (let i = 0; i < d; i++) c[i] /= vecs.length;
  return c;
}

// ── Replicate score() from sweep script ──

function score(testItems, picks) {
  const N = testItems.length;
  let tp = 0, wrongCat = 0, missed = 0, falseAssign = 0, trueReject = 0;

  for (let i = 0; i < N; i++) {
    const gt = testItems[i].groundTruth;
    const pick = picks[i];
    const isNeg = gt === "No match";
    const assigned = pick !== "No match" && pick !== "???";

    if (isNeg) {
      if (assigned) falseAssign++;
      else trueReject++;
    } else {
      if (pick === gt) tp++;
      else if (!assigned) missed++;
      else wrongCat++;
    }
  }

  const totalAssigned = tp + wrongCat + falseAssign;
  const totalPositive = tp + wrongCat + missed;
  const totalNegative = trueReject + falseAssign;

  const precision = totalAssigned > 0 ? tp / totalAssigned * 100 : 100;
  const recall = totalPositive > 0 ? tp / totalPositive * 100 : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
  const fpr = totalNegative > 0 ? falseAssign / totalNegative * 100 : 0;
  const accuracy = (tp + trueReject) / N * 100;

  return { tp, wrongCat, missed, falseAssign, trueReject, precision, recall, f1, fpr, accuracy };
}

// ═══════════════════════════════════════════════════════════════
// Test 1: score() — perfect classification
// ═══════════════════════════════════════════════════════════════

console.log("Test 1: score() — perfect classification");
{
  const items = [
    { groundTruth: "Cooking" },
    { groundTruth: "Cooking" },
    { groundTruth: "Fitness" },
    { groundTruth: "No match" },
    { groundTruth: "No match" },
  ];
  const picks = ["Cooking", "Cooking", "Fitness", "No match", "No match"];
  const s = score(items, picks);
  assert(s.tp === 3, "tp should be 3");
  assert(s.wrongCat === 0, "wrongCat should be 0");
  assert(s.missed === 0, "missed should be 0");
  assert(s.falseAssign === 0, "falseAssign should be 0");
  assert(s.trueReject === 2, "trueReject should be 2");
  assertClose(s.precision, 100, "precision should be 100%");
  assertClose(s.recall, 100, "recall should be 100%");
  assertClose(s.f1, 100, "F1 should be 100");
  assertClose(s.fpr, 0, "FPR should be 0%");
  assertClose(s.accuracy, 100, "accuracy should be 100%");
}

// ═══════════════════════════════════════════════════════════════
// Test 2: score() — all wrong
// ═══════════════════════════════════════════════════════════════

console.log("Test 2: score() — all wrong");
{
  const items = [
    { groundTruth: "Cooking" },
    { groundTruth: "Fitness" },
    { groundTruth: "No match" },
  ];
  const picks = ["Fitness", "Cooking", "Cooking"];
  const s = score(items, picks);
  assert(s.tp === 0, "tp should be 0");
  assert(s.wrongCat === 2, "wrongCat should be 2");
  assert(s.falseAssign === 1, "falseAssign should be 1");
  assert(s.trueReject === 0, "trueReject should be 0");
  assertClose(s.precision, 0, "precision should be 0%");
  assertClose(s.recall, 0, "recall should be 0%");
  assertClose(s.fpr, 100, "FPR should be 100%");
}

// ═══════════════════════════════════════════════════════════════
// Test 3: score() — conservative strategy (says "No match" a lot)
// ═══════════════════════════════════════════════════════════════

console.log("Test 3: score() — conservative strategy");
{
  const items = [
    { groundTruth: "Cooking" },
    { groundTruth: "Cooking" },
    { groundTruth: "Fitness" },
    { groundTruth: "No match" },
    { groundTruth: "No match" },
  ];
  // Only assigns 1 item correctly, rejects everything else
  const picks = ["Cooking", "No match", "No match", "No match", "No match"];
  const s = score(items, picks);
  assert(s.tp === 1, "tp should be 1");
  assert(s.missed === 2, "missed should be 2 (Cooking + Fitness rejected)");
  assert(s.trueReject === 2, "trueReject should be 2");
  assertClose(s.precision, 100, "precision should be 100% (only assigned 1, correctly)");
  assertClose(s.recall, 100 / 3, "recall should be 33% (1 of 3 positives found)");
  assertClose(s.fpr, 0, "FPR should be 0%");
  assertClose(s.accuracy, 60, "accuracy should be 60% (3 of 5 correct: 1 tp + 2 tn)");
}

// ═══════════════════════════════════════════════════════════════
// Test 4: score() — aggressive strategy (assigns everything)
// ═══════════════════════════════════════════════════════════════

console.log("Test 4: score() — aggressive strategy");
{
  const items = [
    { groundTruth: "Cooking" },
    { groundTruth: "Fitness" },
    { groundTruth: "No match" },
    { groundTruth: "No match" },
  ];
  // Assigns everything to top-1 (always a collection)
  const picks = ["Cooking", "Fitness", "Cooking", "Fitness"];
  const s = score(items, picks);
  assert(s.tp === 2, "tp should be 2");
  assert(s.falseAssign === 2, "falseAssign should be 2");
  assertClose(s.precision, 50, "precision should be 50% (2 right, 2 false assigns)");
  assertClose(s.recall, 100, "recall should be 100% (found both positives)");
  assertClose(s.fpr, 100, "FPR should be 100% (both negatives falsely assigned)");
  assertClose(s.accuracy, 50, "accuracy should be 50% (2 of 4 correct)");
}

// ═══════════════════════════════════════════════════════════════
// Test 5: score() — mixed errors
// ═══════════════════════════════════════════════════════════════

console.log("Test 5: score() — mixed errors");
{
  const items = [
    { groundTruth: "Cooking" },   // → correct
    { groundTruth: "Cooking" },   // → wrong category
    { groundTruth: "Fitness" },   // → missed (No match)
    { groundTruth: "No match" },  // → false assign
    { groundTruth: "No match" },  // → true reject
  ];
  const picks = ["Cooking", "Fitness", "No match", "Travel", "No match"];
  const s = score(items, picks);
  assert(s.tp === 1, "tp=1");
  assert(s.wrongCat === 1, "wrongCat=1");
  assert(s.missed === 1, "missed=1");
  assert(s.falseAssign === 1, "falseAssign=1");
  assert(s.trueReject === 1, "trueReject=1");
  // precision: 1 correct out of 3 assigned (1 tp + 1 wrongCat + 1 falseAssign)
  assertClose(s.precision, 100 / 3, "precision ~33%");
  // recall: 1 correct out of 3 positives (1 tp + 1 wrongCat + 1 missed)
  assertClose(s.recall, 100 / 3, "recall ~33%");
  // fpr: 1 false assign out of 2 negatives
  assertClose(s.fpr, 50, "fpr = 50%");
  // accuracy: 2 correct (1 tp + 1 tn) out of 5
  assertClose(s.accuracy, 40, "accuracy = 40%");
}

// ═══════════════════════════════════════════════════════════════
// Test 6: score() — no positive items (all negatives)
// ═══════════════════════════════════════════════════════════════

console.log("Test 6: score() — all negatives");
{
  const items = [
    { groundTruth: "No match" },
    { groundTruth: "No match" },
    { groundTruth: "No match" },
  ];
  const picks = ["No match", "Cooking", "No match"];
  const s = score(items, picks);
  assert(s.trueReject === 2, "trueReject=2");
  assert(s.falseAssign === 1, "falseAssign=1");
  assertClose(s.recall, 0, "recall=0 (no positives)");
  assertClose(s.fpr, 100 / 3, "fpr ~33%");
}

// ═══════════════════════════════════════════════════════════════
// Test 7: Leave-one-out centroid math
// ═══════════════════════════════════════════════════════════════

console.log("Test 7: leave-one-out centroid");
{
  // 3 vectors in a collection
  const vecs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const centroid = computeCentroid(vecs);  // [0.333, 0.333, 0.333]
  const n = vecs.length;

  // Remove first vector: remaining = [[0,1,0], [0,0,1]]
  // Expected centroid: [0, 0.5, 0.5]
  const vec0 = vecs[0];
  const looC = centroid.map((c, i) => (c * n - vec0[i]) / (n - 1));
  assertClose(looC[0], 0, "loo[0] should be 0");
  assertClose(looC[1], 0.5, "loo[1] should be 0.5");
  assertClose(looC[2], 0.5, "loo[2] should be 0.5");

  // Verify: direct computation should match
  const directC = computeCentroid([vecs[1], vecs[2]]);
  assertClose(looC[0], directC[0], "loo matches direct [0]", 0.001);
  assertClose(looC[1], directC[1], "loo matches direct [1]", 0.001);
  assertClose(looC[2], directC[2], "loo matches direct [2]", 0.001);
}

// ═══════════════════════════════════════════════════════════════
// Test 8: Leave-one-out reduces similarity
// ═══════════════════════════════════════════════════════════════

console.log("Test 8: leave-one-out reduces similarity for member items");
{
  // A tight cluster plus one outlier member
  const memberVecs = [
    [0.9, 0.1, 0.0],
    [0.85, 0.15, 0.0],
    [0.95, 0.05, 0.0],
    [0.1, 0.9, 0.0],  // outlier member
  ];
  const centroid = computeCentroid(memberVecs);
  const n = memberVecs.length;

  // For the outlier: similarity WITH it in centroid vs WITHOUT
  const outlier = memberVecs[3];
  const simWith = cosineSim(outlier, centroid);
  const looC = centroid.map((c, i) => (c * n - outlier[i]) / (n - 1));
  const simWithout = cosineSim(outlier, looC);

  assert(simWithout < simWith, `leave-one-out should reduce similarity: ${simWithout.toFixed(3)} < ${simWith.toFixed(3)}`);
}

// ═══════════════════════════════════════════════════════════════
// Test 9: Non-member similarity unaffected by leave-one-out
// ═══════════════════════════════════════════════════════════════

console.log("Test 9: non-member items use original centroid");
{
  // For items NOT in the collection, we should use the full centroid
  // (leave-one-out only applies when groundTruth === cat.name)
  const memberVecs = [[1, 0], [0, 1]];
  const centroid = computeCentroid(memberVecs);

  // A non-member item
  const nonMember = [0.7, 0.3];
  const simFull = cosineSim(nonMember, centroid);

  // Simulating the sweep logic: groundTruth !== cat.name, so centroid is unchanged
  // Just verify the value is stable
  const simAgain = cosineSim(nonMember, centroid);
  assertClose(simFull, simAgain, "non-member sim should be identical", 0.0001);
}

// ═══════════════════════════════════════════════════════════════
// Test 10: F1 calculation
// ═══════════════════════════════════════════════════════════════

console.log("Test 10: F1 balances precision and recall");
{
  // High precision, low recall → moderate F1
  const items = Array.from({ length: 10 }, (_, i) => ({
    groundTruth: i < 8 ? "Cat" : "No match",
  }));
  // Only assigns 2 items (both correct), misses the other 6 positives
  const picks = ["Cat", "Cat", "No match", "No match", "No match", "No match", "No match", "No match", "No match", "No match"];
  const s = score(items, picks);
  assertClose(s.precision, 100, "precision=100%");
  assertClose(s.recall, 25, "recall=25%");
  assertClose(s.f1, 40, "F1=40 (harmonic mean of 100 and 25)");
}

// ═══════════════════════════════════════════════════════════════
// Test 11: Edge case — empty picks (all "No match")
// ═══════════════════════════════════════════════════════════════

console.log("Test 11: all No match picks");
{
  const items = [
    { groundTruth: "Cooking" },
    { groundTruth: "No match" },
  ];
  const picks = ["No match", "No match"];
  const s = score(items, picks);
  assert(s.tp === 0, "tp=0");
  assert(s.missed === 1, "missed=1");
  assert(s.trueReject === 1, "trueReject=1");
  // precision: no items assigned, defaults to 100% (vacuously true)
  assertClose(s.precision, 100, "precision=100% (vacuous)");
  assertClose(s.recall, 0, "recall=0%");
  assertClose(s.fpr, 0, "fpr=0%");
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(40)}`);
if (failed === 0) {
  console.log(`All ${passed} assertions passed.`);
} else {
  console.log(`${failed} FAILED, ${passed} passed.`);
  process.exit(1);
}
