#!/usr/bin/env node
/**
 * Deploy built plugin files to an Obsidian vault.
 *
 * Requires ROOST_DEV_VAULT to be set to the absolute path of your vault:
 *   ROOST_DEV_VAULT=/path/to/vault npm run install:vault
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const vaultRoot = process.env.ROOST_DEV_VAULT;
if (!vaultRoot || !vaultRoot.trim()) {
  console.error(
    "Error: ROOST_DEV_VAULT is not set.\n" +
    "Set it to your Obsidian vault path, e.g.:\n" +
    "  ROOST_DEV_VAULT=/path/to/vault npm run install:vault"
  );
  process.exit(1);
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginDir = path.join(vaultRoot, ".obsidian", "plugins", "roost");
const pluginScriptsDir = path.join(pluginDir, "scripts");

fs.mkdirSync(pluginDir, { recursive: true });
fs.mkdirSync(pluginScriptsDir, { recursive: true });

const copies = [
  [path.join(repoRoot, "dist", "main.js"),              path.join(pluginDir, "main.js")],
  [path.join(repoRoot, "dist", "styles.css"),           path.join(pluginDir, "styles.css")],
  [path.join(repoRoot, "manifest.json"),                path.join(pluginDir, "manifest.json")],
  [path.join(repoRoot, "scripts", "embed-sidecar.py"),  path.join(pluginScriptsDir, "embed-sidecar.py")],
  [path.join(repoRoot, "scripts", "requirements.txt"),  path.join(pluginScriptsDir, "requirements.txt")],
  [path.join(repoRoot, "scripts", "setup-integrations.sh"),          path.join(pluginScriptsDir, "setup-integrations.sh")],
  [path.join(repoRoot, "scripts", "sidecar-launcher.sh"),            path.join(pluginScriptsDir, "sidecar-launcher.sh")],
  [path.join(repoRoot, "scripts", "RoostSidecar.Info.plist"),        path.join(pluginScriptsDir, "RoostSidecar.Info.plist")],
  [path.join(repoRoot, "scripts", "install-sidecar-service.sh"),     path.join(pluginScriptsDir, "install-sidecar-service.sh")],
  [path.join(repoRoot, "scripts", "uninstall-sidecar-service.sh"),   path.join(pluginScriptsDir, "uninstall-sidecar-service.sh")],
];

for (const [src, dest] of copies) {
  if (!fs.existsSync(src)) {
    console.error(`Missing source file: ${src}`);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.log(`  copied  ${path.relative(repoRoot, src)}  →  ${dest}`);
}

// Ensure the shell scripts are executable in the plugin dir.
for (const name of ["setup-integrations.sh", "sidecar-launcher.sh", "install-sidecar-service.sh", "uninstall-sidecar-service.sh"]) {
  try { fs.chmodSync(path.join(pluginScriptsDir, name), 0o755); } catch { /* best-effort */ }
}

console.log(`\nRoost deployed to ${pluginDir}`);
