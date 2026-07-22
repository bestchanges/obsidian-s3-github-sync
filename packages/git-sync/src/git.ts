import { execa } from "execa";

export interface GitChange {
  path: string;
  status: "A" | "M" | "D";
}

export class Git {
  constructor(private cwd: string) {}

  private async run(args: string[], input?: string): Promise<string> {
    const res = await execa("git", args, { cwd: this.cwd, input, reject: false });
    if (res.exitCode !== 0 && res.exitCode !== 1) {
      throw new Error(`git ${args.join(" ")} failed (${res.exitCode}): ${res.stderr}`);
    }
    return res.stdout;
  }

  /** like run() but treats any non-zero exit as failure (run() tolerates exit 1 for diff/quiet). */
  private async runStrict(args: string[]): Promise<string> {
    const res = await execa("git", args, { cwd: this.cwd, reject: false });
    if (res.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${res.exitCode}): ${res.stderr}`);
    }
    return res.stdout;
  }

  async headSha(): Promise<string> {
    return (await this.run(["rev-parse", "HEAD"])).trim();
  }

  async isAncestor(maybeAncestor: string, of: string): Promise<boolean> {
    const res = await execa("git", ["merge-base", "--is-ancestor", maybeAncestor, of], {
      cwd: this.cwd,
      reject: false,
    });
    return res.exitCode === 0;
  }

  /** name-status diff; renames become D(old) + A(new).
   * -z (NUL-terminated) output so non-ASCII paths are emitted raw — git's default core.quotepath
   * octal-escapes and double-quotes them (e.g. Cyrillic note names), which would make every such
   * path unreadable on disk and silently skip the file. With -z the record stream is
   * `status\0path\0` (or `Rxxx\0old\0new\0` for renames/copies). */
  async diffNameStatus(from: string, to: string): Promise<GitChange[]> {
    const out = await this.run(["diff", "--name-status", "-M", "-z", `${from}..${to}`]);
    const tokens = out.split("\0").filter((t) => t !== "");
    const changes: GitChange[] = [];
    let i = 0;
    while (i < tokens.length) {
      const status = tokens[i++];
      if (status.startsWith("R")) {
        changes.push({ path: tokens[i++], status: "D" }, { path: tokens[i++], status: "A" });
      } else if (status.startsWith("C")) {
        i++; // skip source of a copy
        changes.push({ path: tokens[i++], status: "A" });
      } else if (status === "A" || status === "M" || status === "D") {
        changes.push({ path: tokens[i++], status });
      } else {
        i++; // unknown single-path status (e.g. T/U) — consume its path to stay aligned
      }
    }
    return changes;
  }

  async trackedFiles(): Promise<string[]> {
    return (await this.run(["ls-files", "-z"])).split("\0").filter(Boolean);
  }

  /** file content at a commit, or null if it didn't exist there */
  async showAt(commit: string, path: string): Promise<string | null> {
    const res = await execa("git", ["show", `${commit}:${path}`], { cwd: this.cwd, reject: false });
    return res.exitCode === 0 ? res.stdout : null;
  }

  /** SHA of the most recent commit by `author` reachable from `ref` (HEAD by default), or null if
   * none. Used to locate git-sync's own last sync commit — the point where git and S3 last agreed —
   * which is the correct three-way merge base (§3.5). `--author` is a regex over name+email. */
  async lastCommitBy(author: string, ref = "HEAD"): Promise<string | null> {
    const out = (await this.run(["log", "-1", "--format=%H", `--author=${author}`, ref])).trim();
    return out || null;
  }

  /** batch .gitignore check; returns the subset of paths that ARE ignored.
   * -z on both input and output so non-ASCII paths round-trip unquoted (otherwise returned paths
   * come back octal-escaped and never match the raw input keys). */
  async checkIgnore(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const res = await execa("git", ["check-ignore", "-z", "--stdin"], {
      cwd: this.cwd,
      input: paths.join("\0"),
      reject: false, // exit 1 = none ignored
    });
    return new Set(res.stdout.split("\0").filter(Boolean));
  }

  /** commit author date for a path (best available author-time, §3.5) */
  async authorDateIso(path: string): Promise<string> {
    const out = await this.run(["log", "-1", "--format=%aI", "--", path]);
    return out.trim() || new Date().toISOString();
  }

  async stageAll(): Promise<void> {
    await this.run(["add", "-A"]);
  }

  async hasStagedChanges(): Promise<boolean> {
    const res = await execa("git", ["diff", "--cached", "--quiet"], { cwd: this.cwd, reject: false });
    return res.exitCode === 1;
  }

  async commit(message: string): Promise<void> {
    await this.run([
      "-c", "user.name=s3-sync-bot",
      "-c", "user.email=s3-sync-bot@users.noreply.github.com",
      "commit", "-m", message,
    ]);
  }

  /** current branch name, or "HEAD" when detached. */
  async currentBranch(): Promise<string> {
    return (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  async fetch(remote: string, branch: string): Promise<void> {
    await this.runStrict(["fetch", remote, branch]);
  }

  /** hard-reset the working tree + HEAD to `ref` (e.g. origin/main). */
  async resetHard(ref: string): Promise<void> {
    await this.runStrict(["reset", "--hard", ref]);
  }

  /** Push `branch` to `remote`, tolerating a mid-run advance of the remote.
   * A plain push fails non-fast-forward when another serialized run (or a real external push) moved
   * the branch after our checkout. Since our own change is a single sync commit, rebase it onto the
   * new tip and retry. Bounded; a rebase conflict aborts cleanly and fails loudly (next run recovers). */
  async push(remote = "origin", branch = "HEAD", attempts = 3): Promise<void> {
    const target = branch === "HEAD" ? "HEAD" : branch;
    for (let attempt = 1; ; attempt++) {
      const res = await execa("git", ["push", remote, target], { cwd: this.cwd, reject: false });
      if (res.exitCode === 0) return;
      const rejected = /non-fast-forward|fetch first|\[rejected\]/i.test(res.stderr);
      if (!rejected || attempt >= attempts || branch === "HEAD") {
        throw new Error(`git push failed: ${res.stderr}`);
      }
      await this.fetch(remote, branch);
      const rb = await execa("git", ["rebase", `${remote}/${branch}`], { cwd: this.cwd, reject: false });
      if (rb.exitCode !== 0) {
        await execa("git", ["rebase", "--abort"], { cwd: this.cwd, reject: false });
        throw new Error(`git push failed: could not rebase onto ${remote}/${branch}: ${rb.stderr}`);
      }
    }
  }
}
