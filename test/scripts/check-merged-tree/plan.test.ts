import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkFailedLine,
  cleanupFailedLine,
  fetchArgs,
  fetchFailedLine,
  labelFor,
  mergeArgs,
  notMergeableHeader,
  resolveBaseArgs,
  resolveFailedLine,
  resolveHeadArgs,
  successLine,
  unmergedArgs,
  worktreeArgs,
  worktreeFailedLine,
  worktreeRemoveArgs,
} from "#scripts/check-merged-tree/plan.ts";

describe("merged-tree check command plan", () => {
  test("fetches a pull request head and the base in one call", () => {
    expect(fetchArgs({ kind: "pr", number: 2583 }, "main")).toEqual([
      "fetch",
      "origin",
      "pull/2583/head",
      "main",
    ]);
  });

  test("fetches the origin head and the base for a branch head", () => {
    expect(fetchArgs({ kind: "ref", name: "feature" }, "main")).toEqual([
      "fetch",
      "origin",
      "refs/heads/feature",
      "main",
    ]);
  });

  test("resolves the fetched head for either form", () => {
    expect(resolveHeadArgs()).toEqual(["rev-parse", "FETCH_HEAD"]);
    expect(resolveBaseArgs("main")).toEqual(["rev-parse", "origin/main"]);
  });

  test("detaches the worktree at the base commit", () => {
    expect(worktreeArgs("/tmp/wt", "abc123")).toEqual([
      "worktree",
      "add",
      "--detach",
      "/tmp/wt",
      "abc123",
    ]);
  });

  test("merges without a commit or fast-forward", () => {
    expect(mergeArgs("abc123")).toEqual([
      "merge",
      "--no-commit",
      "--no-ff",
      "abc123",
    ]);
  });

  test("lists conflicted paths and removes the worktree forcefully", () => {
    expect(unmergedArgs()).toEqual(["diff", "--name-only", "--diff-filter=U"]);
    expect(worktreeRemoveArgs("/tmp/wt")).toEqual([
      "worktree",
      "remove",
      "--force",
      "/tmp/wt",
    ]);
  });

  test("labels a pull request and a branch differently", () => {
    expect(labelFor({ kind: "pr", number: 2583 })).toBe("PR #2583");
    expect(labelFor({ kind: "ref", name: "feature" })).toBe("feature");
  });

  test("prints the verdict lines", () => {
    expect(successLine("PR #2583", "main")).toBe(
      "MERGED-TREE CHECK PASSED: PR #2583 merges into main",
    );
    expect(notMergeableHeader("feature", "main")).toBe(
      "MERGED-TREE CHECK FAILED: feature does not merge cleanly into main",
    );
    expect(checkFailedLine("feature", "main", "typecheck")).toBe(
      "MERGED-TREE CHECK FAILED: feature merges into main but typecheck fails on the merged tree",
    );
    expect(fetchFailedLine("PR #2583", "main")).toBe(
      "MERGED-TREE CHECK FAILED: cannot fetch PR #2583 or origin/main",
    );
    expect(resolveFailedLine("feature", "main")).toBe(
      "MERGED-TREE CHECK FAILED: cannot resolve feature against origin/main",
    );
    expect(worktreeFailedLine("feature", "main")).toBe(
      "MERGED-TREE CHECK FAILED: cannot create the trial worktree for feature into main",
    );
    expect(cleanupFailedLine()).toBe(
      "MERGED-TREE CHECK FAILED: the trial worktree could not be cleaned up",
    );
  });
});
