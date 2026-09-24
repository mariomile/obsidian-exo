// @ts-check
// The rule set Obsidian's community-plugin review bot runs (eslint-plugin-obsidianmd
// recommended: Obsidian guidelines + type-checked typescript-eslint). Run with
// `pnpm lint:obsidian`; it is part of `pnpm release:check`, so a submission-blocking
// finding fails CI instead of surfacing in the marketplace review.
//
// Plugin source only: tests and build scripts are not part of the review.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "node_modules/**", "docs/**", "assets/**", "tests/**", "scripts/**", "*.mjs", "*.ts"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Not reported by the review bot (2026-09 review of 0.36.0), and noisy on
      // this codebase: String(unknown) on frontmatter values, and brand/feature
      // names in UI strings. Revisit if the review starts flagging them.
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "obsidianmd/ui/sentence-case": "off",
    },
  },
]);
