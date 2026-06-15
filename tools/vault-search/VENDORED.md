# vault-search — vendored copy

Vendored from `j-paterson/vault-search` on 2026-06-15.

This is a clean source snapshot of the vault-search project: a self-contained
Node/TypeScript CLI (`vault-search search/index/stats`) that embeds vault notes
via Ollama and stores the index in a local SQLite database.

## This copy is NOT part of Roost's workspace

It lives under `tools/` (not `packages/`) so Roost's root `npm install` never
touches it — its native dependencies (`better-sqlite3`, `sqlite-vec`) are
optional and only installed on demand.

## Building

This tool is built on demand by `setup-integrations.sh --with-search` (run from
the plugin's deployed `scripts/` directory):

```bash
./setup-integrations.sh --vault-root /path/to/your/vault --with-search
```

This installs npm dependencies, builds the TypeScript, and symlinks the
`vault-search` binary onto your PATH so Roost can detect and use it.

## Manual build

```bash
cd tools/vault-search
npm install
npm run build
```

The built CLI is at `dist/src/cli.js`.
