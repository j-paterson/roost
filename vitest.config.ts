import { defineConfig } from "vitest/config";
import path from "path";
import fs from "fs";

// Replicate the raw probe plugin from vite.config.ts so transitive imports work
function rawProbePlugin() {
  return {
    name: "raw-probe",
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith(".probe")) return null;
      const dir = importer ? path.dirname(importer) : __dirname;
      const resolved = path.resolve(dir, source.replace(/\.probe$/, ".js"));
      return resolved + ".probe";
    },
    load(id: string) {
      if (!id.endsWith(".probe")) return null;
      const filePath = id.replace(/\.probe$/, "");
      try {
        const content = fs.readFileSync(filePath, "utf8");
        return `export default ${JSON.stringify(content)};`;
      } catch {
        return `export default "";`;
      }
    },
  };
}

export default defineConfig({
  plugins: [rawProbePlugin()],
  resolve: {
    alias: [
      // Specific mocks BEFORE the general @ alias so they take priority
      { find: /^@\/main$/, replacement: path.resolve(__dirname, "packages/core/src/__mocks__/main.ts") },
      { find: "obsidian", replacement: path.resolve(__dirname, "packages/core/src/__mocks__/obsidian.ts") },
      { find: "@", replacement: path.resolve(__dirname, "packages/core/src") },
    ],
  },
  test: {
    include: [
      "packages/core/src/**/*.test.ts",
      "packages/core/src/**/*.test.tsx",
      "tests/promo/**/*.test.ts",
      "tests/fixtures/**/*.test.ts",
    ],
    environment: "happy-dom",
    server: {
      deps: {
        // fmin@0.0.4 has extensionless ESM imports; force Vite to inline-transform it.
        inline: ["fmin"],
      },
    },
  },
});
