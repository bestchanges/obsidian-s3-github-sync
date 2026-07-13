import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The real `obsidian` package is types-only (no runtime entry), so tests that import the
      // plugin resolve it to a small stub that provides a recording Notice.
      obsidian: fileURLToPath(
        new URL("./packages/obsidian-plugin/test/obsidian-stub.ts", import.meta.url),
      ),
    },
  },
});
