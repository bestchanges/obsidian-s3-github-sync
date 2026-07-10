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

  /** name-status diff; renames become D(old) + A(new) */
  async diffNameStatus(from: string, to: string): Promise<GitChange[]> {
    const out = await this.run(["diff", "--name-status", "-M", `${from}..${to}`]);
    const changes: GitChange[] = [];
    for (const line of out.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      const status = parts[0];
      if (status.startsWith("R")) {
        changes.push({ path: parts[1], status: "D" }, { path: parts[2], status: "A" });
      } else if (status === "A" || status === "M" || status === "D") {
        changes.push({ path: parts[1], status });
      } else if (status.startsWith("C")) {
        changes.push({ path: parts[2], status: "A" });
      }
    }
    return changes;
  }

  async trackedFiles(): Promise<string[]> {
    return (await this.run(["ls-files"])).split("\n").filter(Boolean);
  }

  /** file content at a commit, or null if it didn't exist there */
  async showAt(commit: string, path: string): Promise<string | null> {
    const res = await execa("git", ["show", `${commit}:${path}`], { cwd: this.cwd, reject: false });
    return res.exitCode === 0 ? res.stdout : null;
  }

  /** batch .gitignore check; returns the subset of paths that ARE ignored */
  async checkIgnore(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const res = await execa("git", ["check-ignore", "--stdin"], {
      cwd: this.cwd,
      input: paths.join("\n"),
      reject: false, // exit 1 = none ignored
    });
    return new Set(res.stdout.split("\n").filter(Boolean));
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

  async push(): Promise<void> {
    const res = await execa("git", ["push"], { cwd: this.cwd, reject: false });
    if (res.exitCode !== 0) throw new Error(`git push failed: ${res.stderr}`);
  }
}
