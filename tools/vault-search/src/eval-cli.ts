import path from "node:path";
import { runEval } from "./eval";
import { closeDb } from "./db";

async function main() {
  const queryFile = process.argv[2] || path.resolve(process.cwd(), "eval-queries.json");
  console.error(`Running eval against ${queryFile}…`);

  const summary = await runEval(queryFile);

  // Per-query detail to stderr; aggregate stats to stdout for easy capture.
  for (const r of summary.results) {
    console.error(
      `${r.first_relevant_rank ?? "—"}\trecall=${r.recall_at_10.toFixed(2)}\tmrr=${r.mrr.toFixed(2)}\t${r.query}`
    );
  }
  console.log(JSON.stringify({
    recall_at_10: summary.recall_at_10,
    mrr: summary.mrr,
    n: summary.results.length,
  }, null, 2));

  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
