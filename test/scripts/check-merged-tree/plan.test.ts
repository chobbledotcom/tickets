import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkFailedLine,
  fetchArgs,
  fetchFailedLine,
  labelFor,
  mergeArgs,
  notMergeableHeader,
  resolveBaseArgs,
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

  test("fetches only the base for a branch head", () => {
    expect(fetchArgs({ kind: "ref", name: "feature" }, "main")).toEqual([
      "fetch",
      "origin",
      "main",
    ]);
  });

  test("resolves a pull request head from FETCH_HEAD", () => {
    expect(resolveHeadArgs({ kind: "pr", number: 2583 })).toEqual([
      "rev-parse",
      "FETCH_HEAD",
    ]);
  });

  test("resolves a branch head in the checkout", () => {
    expect(resolveHeadArgs({ kind: "ref", name: "feature" })).toEqual([
      "rev-parse",
      "--verify",
      "feature^{commit}",
    ]);
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
    expect(worktreeFailedLine("feature", "main")).toBe(
      "MERGED-TREE CHECK FAILED: cannot create the trial worktree for feature into main",
    );
  });
});
