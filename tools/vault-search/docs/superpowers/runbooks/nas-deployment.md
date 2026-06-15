# NAS Deployment Runbook (Synology DSM)

> Goal: bring up the vault-search docker compose stack on the user's Synology NAS with the vault mounted read-only.

## Prerequisites
- Synology DSM 7.x+ with **Container Manager** package installed (Package Center → Container Manager). On older DSM this is "Docker."
- SSH access enabled (Control Panel → Terminal & SNMP → Enable SSH).
- The Obsidian vault is already syncing onto the NAS at `/var/services/homes/jpaters0n/ObsidianVault` (or another path — set `VAULT_HOST_PATH` to match).
- At least 4 GB free RAM for the Ollama embedding model.

## Steps

1. **SSH into the NAS**
   ```bash
   ssh jpaters0n@<nas-host>
   ```

2. **Clone the repo into your home directory**
   ```bash
   cd ~
   git clone <repo-url> vault-search
   cd vault-search
   ```

3. **Create `.env` with a fresh, unique token** (different from the one used in dev)
   ```bash
   cp .env.example .env
   echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
   nano .env   # remove duplicate MCP_AUTH_TOKEN= line if needed
   chmod 600 .env
   ```

4. **Verify the vault path resolves**
   ```bash
   ls "$(grep ^VAULT_HOST_PATH= .env | cut -d= -f2)" | head
   ```
   Expected: lists vault directories (Dashboard, etc.).

5. **Create the data directory**
   ```bash
   mkdir -p "$(grep ^DATA_HOST_PATH= .env | cut -d= -f2)"
   ```

6. **Build and start the stack**
   ```bash
   sudo docker compose up -d --build
   ```
   First run: Ollama pulls `nomic-embed-text`. Watch with `sudo docker compose logs -f ollama`.

7. **Pull the embedding model into Ollama**
   ```bash
   sudo docker exec vault-search-ollama ollama pull nomic-embed-text
   ```

8. **Wait for the first index to complete**
   ```bash
   sudo docker compose logs -f vault-search
   ```
   On a multi-thousand-note vault, the first index takes 5–60 minutes depending on Ollama throughput on the NAS hardware. Look for `[index] done`.

9. **Local health check**
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3099/healthz
   ```
   Expected: `200`.

10. **Search smoke test from the NAS**
    Initialize a session and run `tools/list` and a `search_vault` call against `localhost:3099`, with the token from this NAS's `.env`. (See the curl flow in the project's local dev docs.) Confirm at least one tool call returns expected results.

## Troubleshooting
- **`fs.watch` doesn't pick up changes:** Synology shared folders can have flaky inode-based watching when the vault sync is via Synology Drive or rsync. If the watcher misses changes, fall back to a periodic full reindex by hitting the `reindex` tool from a cron task. (Investigate fix later if needed.)
- **OOM during indexing:** lower `EMBED_CONCURRENCY` in `src/config.ts` from 5 to 2 and rebuild.
- **Ollama slow on NAS CPU:** it's CPU-only (no GPU on most NAS units). Throughput is what it is; consider a smaller embedding model if the first-index wall-clock is unacceptable.

## Regression check after indexer/embedder changes

After the first index completes, capture a baseline:

```bash
sudo docker compose exec vault-search npm run eval > /tmp/eval-baseline.json
cat /tmp/eval-baseline.json
```

Then, after any change to chunker, embedder, or search ranker, re-run:

```bash
sudo docker compose exec vault-search npm run eval > /tmp/eval-after.json
diff <(jq '.recall_at_10, .mrr' /tmp/eval-baseline.json) \
     <(jq '.recall_at_10, .mrr' /tmp/eval-after.json)
```

Investigate any drop >0.05 in `recall_at_10` or `mrr` before deploying. The per-query stderr output (visible in `docker compose logs`) identifies which queries regressed.

## v2 deployment notes (OAuth, multi-vault, host allowlist)

### Sync code from your Mac to the NAS

The NAS doesn't have `git` installed. Sync via rsync over SSH:

```bash
# from your Mac, in the project root
rsync -avz --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.env' \
  --exclude='.worktrees' \
  ./ jpaters0n@192.168.1.65:vault-search/
```

`docker compose up --build` rebuilds the container, which runs `npm install` and `npm run build` inside.

### `.env` for the NAS — additions

Generate / preserve:

```env
MCP_AUTH_TOKEN=<32-byte hex from openssl rand -hex 32>
VAULT_HOST_PATH=/var/services/homes/jpaters0n/Obsidian
DATA_HOST_PATH=/var/services/homes/jpaters0n/vault-search-data
MCP_HOST_PORT=3099
MCP_ALLOWED_HOSTS=syn-1.<tailnet>.ts.net,localhost:3099,127.0.0.1:3099
MCP_OAUTH_ISSUER=https://syn-1.<tailnet>.ts.net
```

Replace `<tailnet>` with your actual tailnet name. Set `MCP_OAUTH_ISSUER` and the Funnel hostname in `MCP_ALLOWED_HOSTS` AFTER Tailscale Funnel is up (Phase 3).

### Multi-vault layout

`VAULT_HOST_PATH` should point to the parent directory containing one or more vault subdirectories. Example layout on the NAS:

```
/var/services/homes/jpaters0n/Obsidian/
├── ObsidianVault/
│   ├── Dashboard/
│   ├── .obsidian/      ← excluded automatically (any-depth match)
│   └── ...
└── ObsidianBookmarks/
    └── ...
```

Search results return paths prefixed with the vault subdir, e.g. `ObsidianVault/Dashboard/Note.md`.

### Bearer rotation

To rotate `MCP_AUTH_TOKEN`:

1. `openssl rand -hex 32` → new token
2. Edit `.env` on the NAS, save
3. `docker compose restart vault-search-mcp`
4. Re-paste the new token in Claude's `/authorize` consent page on next call (Claude transparently re-authorizes)

The in-memory OAuth token store is wiped on container restart. After rotation (or any restart), every connected Claude device redoes the authorize flow once.

### Curl-based smoke testing without OAuth

For local development or scripted testing, set `MCP_DIRECT_BEARER=1` in the env. The OAuth flow is bypassed and `/mcp` accepts the simple `Authorization: Bearer <MCP_AUTH_TOKEN>` directly. **Never set this in production** — Claude.ai's connector won't work without OAuth.

## Pre-deploy checklist

Before bringing the stack up on the NAS, confirm in `.env`:

- [ ] `MCP_AUTH_TOKEN` is set and is a fresh 32-byte hex string (generated with `openssl rand -hex 32`).
- [ ] `MCP_OAUTH_ISSUER` matches your public Funnel HTTPS URL exactly — `https://` prefix, no trailing slash.
- [ ] `MCP_ALLOWED_HOSTS` includes the Funnel hostname AND `localhost:3099`, `127.0.0.1:3099` for in-NAS smoke tests.
- [ ] **`MCP_DIRECT_BEARER` is UNSET (or =0).** This is the curl-only escape hatch and must never be on in production; Claude.ai's connector cannot authenticate against it.
- [ ] `OAUTH_STORE_PATH` resolves to a path inside the `/data` mount (default `/data/oauth-store.json`) so tokens survive container restarts. Confirm at runtime via the `OAuth store persisting to /data/oauth-store.json` log line.

After `docker compose up`, tail the logs and verify the first six startup lines are clean:

```
Host allowlist enabled (N entries)
/debug/recent enabled (master-bearer-gated)
OAuth store persisting to /data/oauth-store.json
OAuth issuer enabled at https://...
[watch] Watching /vault for .md changes (2000ms debounce)
vault-search MCP server started (HTTP) on port 3000
```
