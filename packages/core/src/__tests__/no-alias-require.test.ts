// Guard against a runtime `require("@/...")` shipping in the bundle.
// The `@/` alias is build-time only (vite/tsconfig); a literal runtime
// `require("@/...")` survives bundling and throws "Cannot find module" in
// Electron at the moment that code path runs (e.g. deleting a gallery item).
// Use static `import` (or `await import(...)`) instead so Vite resolves +
// bundles it. See the vault-utils deleteItem regression.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__mocks__" || entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("no runtime @/ alias require", () => {
  it("no source file uses require(\"@/...\") — it won't resolve at runtime", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      if (/require\(\s*["'`]@\//.test(text)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });
});
