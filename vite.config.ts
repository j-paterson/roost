import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import builtins from "builtin-modules";

// Plugin to load .probe files as raw text strings
function rawProbePlugin() {
  return {
    name: "raw-probe",
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith(".probe")) return null;
      // Resolve relative to the importing file
      const dir = importer ? path.dirname(importer) : __dirname;
      const resolved = path.resolve(dir, source.replace(/\.probe$/, ".js"));
      return resolved + ".probe";
    },
    load(id: string) {
      if (!id.endsWith(".probe")) return null;
      const filePath = id.replace(/\.probe$/, "");
      const content = fs.readFileSync(filePath, "utf8");
      return `export default ${JSON.stringify(content)};`;
    },
  };
}

export default defineConfig({
  plugins: [react(), rawProbePlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "packages/core/src"),
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, "packages/core/src/main.ts"),
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: (id) => {
        // Static list of always-external packages (Obsidian, CodeMirror, Lezer)
        const alwaysExternal = [
          "obsidian",
          "electron",
          "@codemirror/autocomplete",
          "@codemirror/collab",
          "@codemirror/commands",
          "@codemirror/language",
          "@codemirror/lint",
          "@codemirror/search",
          "@codemirror/state",
          "@codemirror/view",
          "@lezer/common",
          "@lezer/highlight",
          "@lezer/lr",
        ];
        if (alwaysExternal.includes(id)) return true;

        // Node built-in modules
        const builtinSet = new Set([...builtins, ...builtins.map(m => `node:${m}`)]);
        if (builtinSet.has(id)) return true;

        return false;
      },
      output: {
        assetFileNames: "styles.css",
        // Keep the plugin as a single main.js file even when async import()
        // is used for lazy modules (e.g. Leaflet deferred until Places map opens).
        inlineDynamicImports: true,
        globals: {
          obsidian: "obsidian",
          electron: "electron",
        },
      },
    },
    cssCodeSplit: false,
    sourcemap: process.env.NODE_ENV !== "production" ? "inline" : false,
    emptyOutDir: false,
    outDir: "dist",
    minify: process.env.NODE_ENV === "production",
  },
});
