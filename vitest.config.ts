import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use the child-process pool, not the default worker-threads pool. The engine schedules
    // short-lived timers (withApplying's 500 ms cleanup, the logger's flush debounce); on CI runners
    // the threads pool intermittently fails to terminate its workers after the run, so `vitest run`
    // never exits and the job hangs (fine locally, wedged on GitHub). Forked processes are killed
    // cleanly, so the run always exits.
    pool: "forks",
  },
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
