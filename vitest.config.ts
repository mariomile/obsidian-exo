import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The core modules under test are pure and must NOT import `obsidian` at
    // runtime. This alias is a safety net: if a transitive import ever sneaks
    // one in, tests resolve to a tiny stub instead of failing to load.
    alias: {
      obsidian: resolve(__dirname, "tests/__mocks__/obsidian.ts"),
    },
  },
});
