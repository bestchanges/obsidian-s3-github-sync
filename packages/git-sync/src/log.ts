/**
 * Leveled logger for the git-sync leg. The sink is the GitHub Actions run log (stdout), so lines are
 * plain `[git-sync] LEVEL msg`; the runner timestamps each line for us. Mirrors the plugin's logger
 * shape (packages/obsidian-plugin/src/logger.ts) so both legs read alike.
 *
 * Level threshold comes from LOG_LEVEL (debug|info|warn|error, default info); anything below is
 * dropped. When running under Actions (GITHUB_ACTIONS=true), warn/error also emit a ::warning:: /
 * ::error:: workflow command so they annotate the run summary, and group()/endGroup() emit the
 * collapsible ::group:: / ::endgroup:: markers. Outside Actions those degrade to plain lines / no-ops
 * so a local run stays readable.
 */
export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Open a collapsible section in the Actions log (no-op locally). */
  group(name: string): void;
  /** Close the section opened by group() (no-op locally). */
  endGroup(): void;
}

function parseLevel(raw: string | undefined): Level {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}

export function createLogger(env: NodeJS.ProcessEnv = process.env): Logger {
  const threshold = ORDER[parseLevel(env.LOG_LEVEL)];
  const inActions = env.GITHUB_ACTIONS === "true";

  const emit = (level: Level, msg: string): void => {
    if (ORDER[level] < threshold) return;
    const line = `[git-sync] ${level.toUpperCase().padEnd(5)} ${msg}`;
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
    // Surface warnings/errors in the run summary as native Actions annotations.
    if (inActions && (level === "warn" || level === "error")) {
      console.log(`::${level === "warn" ? "warning" : "error"}::${msg}`);
    }
  };

  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    group: (name) => {
      if (inActions) console.log(`::group::${name}`);
    },
    endGroup: () => {
      if (inActions) console.log(`::endgroup::`);
    },
  };
}
