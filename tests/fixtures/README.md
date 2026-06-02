# E2E / promo fixture vault

## Regenerate

**Synthetic** (fast, no media):

```bash
npm run fixture:vault
```

**From production bookmarks** (real TikTok posts, covers, and `media.mp4` under `Bookmarks/_assets/`):

```bash
npm run fixture:vault:import
```

Uses `ROOST_FIXTURE_VAULT` if set; default is your Synology Obsidian bookmarks vault.

Writes `vault-import-manifest.json` with chip hints for gallery e2e and Smart Assign group names (`Travel & places`, `Media & culture`, etc.).

Products/Workouts notes without pipeline fields in the vault get minimal synthetic frontmatter merged in (real title + video kept). Places get map pin coordinates from the synthetic place table when the vault note has no `place_lat`.

## Promo

After import:

```bash
npm run capture:promo
npm run promo:experiments
```
