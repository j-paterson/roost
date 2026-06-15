#!/usr/bin/env node
import { indexVault, getStats } from "./indexer";
import { searchVault, findSimilar, getContext } from "./search";
import { closeDb } from "./db";

async function main() {
  const [command, ...args] = process.argv.slice(2);

  try {
    switch (command) {
      case "index": {
        const full = args.includes("--full");
        const stats = await indexVault((phase, cur, total, detail) => {
          if (phase === "done") {
            console.error(`✓ ${detail}`);
          } else {
            console.error(`[${phase}] ${cur}/${total}${detail ? ` — ${detail}` : ""}`);
          }
        }, full);
        console.log(JSON.stringify(stats, null, 2));
        break;
      }

      case "search": {
        const query = args.filter(a => !a.startsWith("--")).join(" ");
        const limitArg = args.find(a => a.startsWith("--limit="));
        const limit = limitArg ? parseInt(limitArg.split("=")[1]) : 10;
        if (!query) { console.error("Usage: vault-search search <query>"); process.exit(1); }
        const results = await searchVault(query, { limit });
        console.log(JSON.stringify(results, null, 2));
        break;
      }

      case "similar": {
        const filePath = args[0];
        if (!filePath) { console.error("Usage: vault-search similar <file-path>"); process.exit(1); }
        const limitArg = args.find(a => a.startsWith("--limit="));
        const limit = limitArg ? parseInt(limitArg.split("=")[1]) : 10;
        const results = await findSimilar(filePath, { limit });
        console.log(JSON.stringify(results, null, 2));
        break;
      }

      case "context": {
        const filePath = args[0];
        if (!filePath) { console.error("Usage: vault-search context <file-path>"); process.exit(1); }
        const result = getContext(filePath);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "stats": {
        const stats = getStats();
        console.log(JSON.stringify(stats, null, 2));
        break;
      }

      default:
        console.error("vault-search — Hybrid semantic + keyword search for Obsidian vaults");
        console.error("");
        console.error("Commands:");
        console.error("  index [--full]              Index vault (incremental or full rebuild)");
        console.error("  search <query> [--limit=N]  Hybrid semantic + keyword search");
        console.error("  similar <file-path>         Find similar notes");
        console.error("  context <file-path>         Get full file content");
        console.error("  stats                       Show index statistics");
        process.exit(1);
    }
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
