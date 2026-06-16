# Roost

Sync your socials (**TikTok** and **X/Twitter** bookmarks) into your Obsidian vault as
markdown notes, then auto-organize them with a local AI categorizer.

> **Desktop only.** Roost uses an Electron webview and local tools that aren't
> available on Obsidian mobile.

## What it does

- **Sync bookmarks** — opens your TikTok / X bookmarks in an in-app webview (on
  your action) and writes each into the vault as a note. You log in as yourself;
  Roost only reads your own bookmarks.
- **Smart Assign** — categorizes notes by embedding similarity plus an optional
  LLM rerank, writing a `roost_category` field. Within a category, a second
  scoring pass can auto-assign a `roost_subcategory` (e.g. "Italian" inside
  "Cooking"), producing a two-level library tree.
- **Local video transcripts** — caption-less TikTok videos can be transcribed
  locally (faster-whisper via the sidecar's `/transcribe`) so the recipe and
  other pipelines can read the speech; music/silent videos are skipped.
- **Gallery & library views** — browse and filter your synced bookmarks.

## Network use

Roost contacts third-party hosts in several situations:

| Host | When | Why |
|---|---|---|
| `tiktok.com` / `x.com` (webview) | You start a sync | Read your own bookmarks |
| `api.anthropic.com` | Optional cloud LLM, only if you set an API key | Smart Assign rerank |
| `api.themoviedb.org`, `www.omdbapi.com`, `itunes.apple.com`, `openlibrary.org`, `api.jikan.moe`, `graphql.anilist.co` | Media/book/anime enrichment | Titles + cover art |
| `nominatim.openstreetmap.org`, `*.basemaps.cartocdn.com` | Places view | Geocoding + map tiles |
| `abs.twimg.com` | X article backfill | Part of X sync (see below) |

"Where to listen/watch" links (Spotify, SoundCloud, YouTube, Letterboxd, …) are plain links you click — Roost fetches nothing from them, except the optional Spotify embed which loads from `open.spotify.com` when shown.

No telemetry, no analytics, no account.

## Bookmark sync — how it works, and the risk

Syncing reads your **own** TikTok / X bookmarks by automating those sites inside an Obsidian webview: it observes and replays the sites' internal (non-public) requests using your logged-in session. **This is against TikTok's and X's Terms of Service** (which prohibit automated/scraped access, use of non-public interfaces, and reverse engineering), and could in principle lead to account limits or action. Roost shares your data with no one but those platforms — but you are choosing to automate them. **Use at your own risk.** Roost is an independent project, unaffiliated with TikTok or X.

## Optional integrations (all off by default)

Roost never installs or launches anything. Enable an integration in the Roost
Hub and Roost will **use it if it's available**, or show setup instructions if
not:

| Integration | Unlocks | You provide |
|---|---|---|
| **Ollama** (`localhost:11434`) | Embeddings + LLM rerank for Smart Assign | Run Ollama yourself; `ollama pull nomic-embed-text` + a chat model |
| **Embedding sidecar** (`localhost:11435`) | Fine-tuned embeddings | Run the bundled `scripts/embed-sidecar.py` |
| **ffmpeg** | Video-frame vision in embeddings | `ffmpeg`/`ffprobe` on your PATH |
| **vault-search** (Semantic Search) | Semantic vault-search command | Bundled — build with `setup-integrations.sh --with-search` |

With no integrations enabled, sync and the gallery/library views work fully;
Smart Assign is disabled until an embedding backend (Ollama or the sidecar) is
enabled and detected.

## Install

### Install from source (recommended)

Roost is distributed as source. Clone the repo, build, and deploy to your vault
with a single command:

```bash
git clone https://github.com/j-paterson/roost-obsidian.git
cd roost-obsidian
npm install
ROOST_DEV_VAULT=/path/to/your/vault npm run install:vault
```

Then enable **Roost** in Obsidian → Settings → Community plugins. Desktop only.

### Manual install from a release

Download `main.js`, `manifest.json`, and `styles.css` from the latest
[release](https://github.com/j-paterson/roost-obsidian/releases) into
`<vault>/.obsidian/plugins/roost/`.

### Local AI sidecar (optional)

Deploying with `npm run install:vault` copies a self-contained setup system into
the plugin's `scripts/` dir, so the venv + sidecar live alongside the plugin and
survive without a repo clone. To set up the embedding sidecar (and Ollama/ffmpeg
detection), run setup **from the plugin scripts dir**:

```bash
cd <your-vault>/.obsidian/plugins/roost/scripts
./setup-integrations.sh --vault-root <your-vault>
```

On macOS this also installs a login-item LaunchAgent that auto-starts the sidecar
(remove it with `./uninstall-sidecar-service.sh`, or skip it with `--skip-autostart`).

### Semantic Search — vault-search (optional)

The **Semantic Search** lego (`vault-search`) is bundled with Roost. To build it
and put the `vault-search` CLI on your PATH, pass `--with-search`:

```bash
./setup-integrations.sh --vault-root <your-vault> --with-search
```

This compiles the TypeScript source and symlinks `vault-search` onto your PATH
so Roost's Integrations panel detects it automatically.

## Running backfills and pipelines

The Roost Hub has two one-click buttons:

- **Backfill all** — runs the content backfills (media, transcripts, tweet
  bodies, threads, article bodies, playback) one at a time.
- **Run pipelines** — runs the enabled category pipelines (recipe, place, media,
  …) over your notes.

## Trademarks

"TikTok" and "X" and their logos are trademarks of their respective owners.
Roost is an independent project and is not affiliated with, endorsed by, or
sponsored by TikTok or X. Brand glyphs are from [simple-icons](https://simpleicons.org) (CC0).

## License

[MIT](LICENSE)
