// Minimal, high-signal ESLint flat config. Deliberately NOT the full
// typescript-eslint recommended preset — see plans/027-eslint-setup.md.
// Type-aware linting is intentionally OFF (no parserOptions.project) to keep
// `npm run lint` fast and config-light. Expand the rule set in a follow-up.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    // Global ignores — keep this first.
    ignores: [
      "dist/**",
      "node_modules/**",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "tests/e2e/**",
      "scripts/promo/**",
      "coverage/**",
      "main.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: "19.0" } },
    rules: {
      // --- high-signal, repo-specific value ---
      // tsconfig has no noUnusedLocals; this is the rule that catches the dead
      // imports/vars that tsc silently allows. Warn (not error) so it never
      // breaks the build, but it shows up in `npm run lint`.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-debugger": "error",

      // --- intentionally relaxed: this codebase's established patterns ---
      // App logs intentionally; many any-casts are deliberate interop seams.
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "react/react-in-jsx-scope": "off", // React 19 + automatic runtime
      "react/prop-types": "off", // TS handles prop types
      "no-undef": "off", // TS handles undefined-symbol detection

      // --- recommended-preset errors downgraded to "warn" ---
      // These are established-pattern noise on this mature codebase, not real
      // bugs. Demoted to "warn" (config-only, zero source edits) so `npm run
      // lint` exits 0 on the additive-setup baseline; a future cleanup plan can
      // graduate them back to "error" once addressed. See plans/027-eslint-setup.md.
      "@typescript-eslint/no-require-imports": "warn", // CJS interop (require() in desktop Node paths)
      "@typescript-eslint/ban-ts-comment": "warn", // deliberate @ts-ignore/@ts-expect-error interop seams
      "@typescript-eslint/no-this-alias": "warn", // intentional `const self = this` captures
      "prefer-const": "warn", // never-reassigned lets flagged across the tree
      "no-empty": "warn", // intentional empty catch blocks
      "no-useless-escape": "warn", // stylistic regex-escape noise
      "no-extra-boolean-cast": "warn", // stylistic !!x noise
      "no-regex-spaces": "warn", // stylistic regex spacing
      "no-control-regex": "warn", // intentional control-char regexes (sanitizers)
    },
  },
);
