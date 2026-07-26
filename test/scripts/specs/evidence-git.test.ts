import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RunCommand } from "#scripts/precommit/git.ts";
import type { CapturedOutput } from "#scripts/process.ts";
import { defineEvidenceCommit } from "#scripts/specs/evidence/git.ts";

const result = (
  stdout: string,
  success = true,
  stderr = "",
): CapturedOutput => ({
  code: success ? 0 : 1,
  stderr,
  stdout,
  success,
});

const gitFixture = (
  results: CapturedOutput[],
): {
  calls: Array<{ cmd: string[]; cwd: string | undefined }>;
  readCommit: (cwd: string) => Promise<string>;
} => {
  const calls: Array<{ cmd: string[]; cwd: string | undefined }> = [];
  const remaining = [...results];
  const run: RunCommand = (cmd, options) => {
    calls.push({ cmd, cwd: options?.cwd });
    const next = remaining.shift();
    if (!next) throw new Error("No Git fixture result remains");
    return Promise.resolve(next);
  };
  return { calls, readCommit: defineEvidenceCommit(run) };
};

describe("Cucumber evidence Git provenance", () => {
  test("returns the commit for a clean SHA-1 worktree", async () => {
    const commit = "a".repeat(40);
    const { calls, readCommit } = gitFixture([result(""), result(commit)]);

    expect(await readCommit("/repo")).toBe(commit);
    expect(calls).toEqual([
      {
        cmd: ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        cwd: "/repo",
      },
      { cmd: ["git", "rev-parse", "HEAD"], cwd: "/repo" },
    ]);
  });

  test("rejects every dirty worktree state", async () => {
    for (const status of [" M tracked.txt", "?? untracked.txt"]) {
      const { readCommit } = gitFixture([result(status)]);
      await expect(readCommit("/repo")).rejects.toThrow(status.trim());
    }
  });

  test("surfaces Git command failures", async () => {
    const failures = [
      [result("", false, "status failed")],
      [result(""), result("", false, "revision failed")],
    ];
    for (const results of failures) {
      const { readCommit } = gitFixture(results);
      await expect(readCommit("/repo")).rejects.toThrow("failed");
    }
  });

  test("rejects a non-SHA-1 commit", async () => {
    const commit = "b".repeat(64);
    const { readCommit } = gitFixture([result(""), result(commit)]);

    await expect(readCommit("/repo")).rejects.toThrow(
      `Git returned an invalid commit: ${commit}`,
    );
  });
});
