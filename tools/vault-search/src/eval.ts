import fs from "fs";
import path from "path";
import { searchVault } from "./search";

interface EvalQuery {
  query: string;
  relevant: string[];
}

interface EvalResult {
  query: string;
  recall_at_10: number;
  mrr: number;
  relevant_found: string[];
  relevant_missed: string[];
  first_relevant_rank: number | null;
}

export async function runEval(queryFile: string, limit = 10): Promise<{
  results: EvalResult[];
  recall_at_10: number;
  mrr: number;
}> {
  const queries: EvalQuery[] = JSON.parse(fs.readFileSync(queryFile, "utf-8"));
  const results: EvalResult[] = [];

  let totalRecall = 0;
  let totalRR = 0;

  for (const { query, relevant } of queries) {
    const searchResults = await searchVault(query, { limit });
    const resultPaths = searchResults.map(r => r.filePath);

    // Check which relevant docs were found
    const found: string[] = [];
    const missed: string[] = [];
    let firstRelevantRank: number | null = null;

    for (const relDoc of relevant) {
      const idx = resultPaths.indexOf(relDoc);
      if (idx >= 0) {
        found.push(relDoc);
        if (firstRelevantRank === null) firstRelevantRank = idx + 1;
      } else {
        missed.push(relDoc);
      }
    }

    // Also check for first relevant in result order
    for (let i = 0; i < resultPaths.length; i++) {
      if (relevant.includes(resultPaths[i])) {
        firstRelevantRank = i + 1;
        break;
      }
    }

    const recall = relevant.length > 0 ? found.length / relevant.length : 0;
    const rr = firstRelevantRank !== null ? 1 / firstRelevantRank : 0;

    totalRecall += recall;
    totalRR += rr;

    results.push({
      query,
      recall_at_10: recall,
      mrr: rr,
      relevant_found: found,
      relevant_missed: missed,
      first_relevant_rank: firstRelevantRank,
    });
  }

  const n = queries.length;
  return {
    results,
    recall_at_10: totalRecall / n,
    mrr: totalRR / n,
  };
}
