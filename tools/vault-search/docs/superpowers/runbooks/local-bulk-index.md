# Local Bulk Indexing on MBP

> Goal: run the slow batch indexing on your MacBook Pro (Apple Silicon, fast Ollama via Metal), then ship the resulting SQLite DB to the NAS for query-time serving.

## When to use this

- Initial index of a new vault (especially `ObsidianBookmarks` — too slow on the NAS Celeron).
- After indexer / chunker / embedder code changes that require re-embedding all chunks.
- Recovering from a corrupted index.

For incremental updates as you edit notes, the NAS watcher handles it fine — don't bother running this for normal use.

## Prerequisites

- Vault is replicated locally via Synology Drive client at `~/Library/CloudStorage/SynologyDrive-Obsidian/<VaultName>/`.
- Ollama is running locally (`ollama serve` or via the desktop app) with `nomic-embed-text` pulled.
- SSH key access to the NAS (already set up).
- This repo built locally: `npm run build`.

## Workflow

### 1. Pull the current NAS DB

```bash
mkdir -p /tmp/vault-data
scp -O jpaters0n@192.168.1.65:vault-search-data/search.db /tmp/vault-data/search.db
```

### 2. Run the indexer locally (using local Ollama)

```bash
cd ~/Projects/vault-search
VAULT_PATH=~/Library/CloudStorage/SynologyDrive-Obsidian/ObsidianVault \
DB_PATH=/tmp/vault-data/search.db \
OLLAMA_URL=http://localhost:11434 \
EMBED_MODEL=nomic-embed-text \
node dist/src/cli.js index
```

Replace `ObsidianVault` with `ObsidianBookmarks` (or any other vault subdir) as needed.

`index` is incremental — only touches changed files. To force a full rebuild, delete the DB first; `--full` is currently broken (see follow-up issue: `no such column: T.file_title`).

### 3. Checkpoint the WAL into the main DB file

**CRITICAL.** SQLite's WAL mode keeps pending writes in a separate `*-wal` file. `scp` only copies the `.db` file, so without checkpointing first, the NAS sees a stale pre-WAL state.

```bash
node -e "const db = require('better-sqlite3')('/tmp/vault-data/search.db'); console.log(db.pragma('wal_checkpoint(TRUNCATE)')); db.close();"
```

Verify counts now match raw SQLite:

```bash
sqlite3 /tmp/vault-data/search.db 'SELECT count(*) FROM files; SELECT count(*) FROM chunks;'
```

### 4. Ship the DB to the NAS

```bash
# Stop the NAS container so the DB isn't held open during write
ssh jpaters0n@192.168.1.65 'docker compose -f vault-search/docker-compose.yml stop vault-search'

# Push the DB
scp -O /tmp/vault-data/search.db jpaters0n@192.168.1.65:vault-search-data/search.db

# Remove any stale WAL/SHM siblings on the NAS, then restart
ssh jpaters0n@192.168.1.65 'rm -f /var/services/homes/jpaters0n/vault-search-data/search.db-wal /var/services/homes/jpaters0n/vault-search-data/search.db-shm ; docker compose -f vault-search/docker-compose.yml start vault-search'
```

### 5. Verify on the NAS

```bash
ssh jpaters0n@192.168.1.65 'docker exec vault-search-mcp node dist/src/cli.js stats'
```

Should match what you saw locally.

```bash
ssh jpaters0n@192.168.1.65 'docker exec vault-search-mcp node dist/src/cli.js search "your test query"'
```

### 6. Re-authorize Claude

Container restart wipes the in-memory OAuth token store. Open Claude.ai, find the connector, hit reconnect — paste the bearer token on the consent page (one click).

## Performance reference

| Scenario | NAS (Celeron J4125) | MBP (M-series) |
|---|---|---|
| Single chunk embed | ~0.5s | ~0.04s (Metal) |
| Re-embed 451 chunks (incremental) | ~225s | ~18s |
| Full ObsidianVault index (~3,500 chunks) | ~30 min | ~60s |
| Full ObsidianBookmarks index (estimated, ~250k chunks) | ~25h | ~3h |

Numbers approximate; depends on Ollama batch settings (`EMBED_CONCURRENCY`, `EMBED_BATCH_SIZE`).

## Troubleshooting

- **`unable to open database file` from container** — Make sure you're on a build that includes the `DB_PATH` env-var fix (commit `e569ce3` or later). Earlier builds ignored the env var and tried to open the in-vault DB at `/vault/.vault-search/search.db`.
- **Stats show 0 embeddings on the NAS but local stats show many** — You forgot Step 3 (checkpoint). The WAL has all your embeddings; the `.db` file alone doesn't.
- **`no such column: T.file_title` from `index --full`** — Known bug. Use plain `index` (incremental). Delete the DB file if you need a full rebuild from scratch.
- **NAS file is owned by root and you can't overwrite via scp** — `chmod u+w` it via SSH first, then scp.
