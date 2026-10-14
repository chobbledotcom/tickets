import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ParsedArgs } from "#scripts/check-merged-tree/args.ts";
import {
  type CommandResult,
  type MergeTreeDeps,
  runMergedTreeCheck,
} from "#scripts/check-merged-tree/run.ts";

const ok: CommandResult = { stderr: "", stdout: "", success: true };

/** Scripted git answers, keyed by the joined argv, e.g.
 *  "rev-parse FETCH_HEAD". Unlisted git commands succeed with no output. */
const gitByCommand =
  (map: Record<string, CommandResult>) =>
  (program: string, args: readonly string[]): Promise<CommandResult> =>
    Promise.resolve(program === "git" ? (map[args.join(" ")] ?? ok) : ok);

const fakeDeps = (
  overrides: {
    command?: MergeTreeDeps["command"];
    denoTask?: MergeTreeDeps["denoTask"];
    removeTree?: MergeTreeDeps["removeTree"];
  } = {},
) => {
  const calls: {
    args: readonly string[];
    cwd: string | undefined;
    program: string;
  }[] = [];
  const logs: string[] = [];
  const tasks: { cwd: string; task: string }[] = [];
  const copied: string[] = [];
  const removed: string[] = [];
  const deps: MergeTreeDeps = {
    command: (program, args, cwd) => {
      calls.push({ args, cwd, program });
      return overrides.command
        ? overrides.command(program, args, cwd)
        : Promise.resolve(ok);
    },
    copyStripeMock: (worktree) => {
      copied.push(worktree);
      return Promise.resolve();
    },
    denoTask: (task, cwd) => {
      tasks.push({ cwd, task });
      return overrides.denoTask
        ? overrides.denoTask(task, cwd)
        : Promise.resolve(0);
    },
    log: (line) => {
      logs.push(line);
    },
    makeTempDir: () => {
      calls.push({ args: [], cwd: undefined, program: "makeTempDir" });
      return Promise.resolve("/tmp/merged-tree-fake");
    },
    removeTree: async (path) => {
      if (overrides.removeTree) {
        await overrides.removeTree(path);
        return;
      }
      removed.push(path);
    },
  };
  return { calls, copied, deps, logs, removed, tasks };
};

const prArgs: ParsedArgs = {
  base: "main",
  head: { kind: "pr", number: 2583 },
};

/** The two ref resolutions every scenario that reaches the merge needs. */
const resolvesHeads = {
  "rev-parse FETCH_HEAD": { ...ok, stdout: "headsha\n" },
  "rev-parse origin/main": { ...ok, stdout: "basesha\n" },
};

/** The check stopped before any worktree or task ran. */
const expectNoWorktree = (fake: {
  calls: { args: readonly string[]; program: string }[];
  tasks: unknown[];
}): void => {
  expect(fake.calls.some((one) => one.program === "makeTempDir")).toBe(false);
  expect(fake.calls.some((one) => one.args[0] === "worktree")).toBe(false);
  expect(fake.tasks).toEqual([]);
};

/** The verdict names the cleanup failure instead of a pass. */
const expectCleanupFailure = (fake: { logs: string[] }): void => {
  expect(fake.logs).toContain(
    "MERGED-TREE CHECK FAILED: the trial worktree could not be cleaned up",
  );
  expect(
    fake.logs.some((line) => line.startsWith("MERGED-TREE CHECK PASSED")),
  ).toBe(false);
};

/** Run a named origin head through the check with scripted git answers. */
const runRefHead = async (name: string, map: Record<string, CommandResult>) => {
  const fake = fakeDeps({ command: gitByCommand(map) });
  const code = await runMergedTreeCheck(
    { base: "main", head: { kind: "ref", name } },
    fake.deps,
  );
  return { code, fake };
};

/** The clean scenario with the worktree removal replaced. */
const withRemoval = (removal: () => Promise<CommandResult>) =>
  fakeDeps({
    command: (program, args) =>
      program === "git" && args[0] === "worktree" && args[1] === "remove"
        ? removal()
        : gitByCommand({ ...resolvesHeads })(program, args),
  });

describe("merged-tree check runner", () => {
  test("passes when the merge and both tree tasks succeed", async () => {
    const fake = fakeDeps({
      command: gitByCommand({ ...resolvesHeads }),
    });
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(0);
    expect(fake.tasks).toEqual([
      { cwd: "/tmp/merged-tree-fake", task: "typecheck" },
      { cwd: "/tmp/merged-tree-fake", task: "test" },
    ]);
    expect(fake.copied).toEqual(["/tmp/merged-tree-fake"]);
    expect(fake.calls).toContainEqual({
      args: ["worktree", "add", "--detach", "/tmp/merged-tree-fake", "basesha"],
      cwd: undefined,
      program: "git",
    });
    expect(fake.calls).toContainEqual({
      args: ["merge", "--no-commit", "--no-ff", "headsha"],
      cwd: "/tmp/merged-tree-fake",
      program: "git",
    });
    expect(fake.calls).toContainEqual({
      args: ["worktree", "remove", "--force", "/tmp/merged-tree-fake"],
      cwd: undefined,
      program: "git",
    });
    expect(fake.removed).toEqual(["/tmp/merged-tree-fake"]);
    expect(fake.logs).toContain(
      "MERGED-TREE CHECK PASSED: PR #2583 merges into main",
    );
  });

  test("reports the conflicted paths when the merge fails", async () => {
    const fake = fakeDeps({
      command: gitByCommand({
        "diff --name-only --diff-filter=U": {
          ...ok,
          stdout: "src/a.ts\nsrc/b.ts\n",
        },
        "fetch origin refs/heads/feature main": ok,
        "merge --no-commit --no-ff headsha": {
          ...ok,
          stderr: "CONFLICT (content): Merge conflict in src/a.ts\n",
          success: false,
        },
        "rev-parse FETCH_HEAD": { ...ok, stdout: "headsha\n" },
        "rev-parse origin/main": { ...ok, stdout: "basesha\n" },
      }),
    });
    const code = await runMergedTreeCheck(
      { base: "main", head: { kind: "ref", name: "feature" } },
      fake.deps,
    );
    expect(code).toBe(1);
    expect(fake.tasks).toEqual([]);
    expect(fake.logs).toContain(
      "MERGED-TREE CHECK FAILED: feature does not merge cleanly into main",
    );
    expect(fake.logs).toContain(
      "CONFLICT (content): Merge conflict in src/a.ts",
    );
    expect(fake.logs).toContain("  conflicted: src/a.ts");
    expect(fake.logs).toContain("  conflicted: src/b.ts");
    expect(fake.removed).toEqual(["/tmp/merged-tree-fake"]);
    expect(fake.calls).toContainEqual({
      args: ["worktree", "remove", "--force", "/tmp/merged-tree-fake"],
      cwd: undefined,
      program: "git",
    });
  });

  test("reports the git error when no paths are conflicted", async () => {
    const fake = fakeDeps({
      command: gitByCommand({
        "merge --no-commit --no-ff headsha": {
          ...ok,
          stderr: "error: could not apply the merge\n",
          success: false,
        },
        ...resolvesHeads,
      }),
    });
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(1);
    expect(fake.logs).toContain("error: could not apply the merge");
    expect(fake.logs.some((line) => line.startsWith("  conflicted:"))).toBe(
      false,
    );
  });

  /** One tree task fails on an otherwise clean merged tree. */
  const failsOnTreeTask = async (failing: "typecheck" | "test") => {
    const fake = fakeDeps({
      command: gitByCommand({ ...resolvesHeads }),
      denoTask: (task) => Promise.resolve(task === failing ? 1 : 0),
    });
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    return { code, fake };
  };

  test("fails fast when typecheck fails on the merged tree", async () => {
    const { code, fake } = await failsOnTreeTask("typecheck");
    expect(code).toBe(2);
    expect(fake.tasks).toEqual([
      { cwd: "/tmp/merged-tree-fake", task: "typecheck" },
    ]);
    expect(fake.logs).toContain(
      "MERGED-TREE CHECK FAILED: PR #2583 merges into main but typecheck fails on the merged tree",
    );
    expect(fake.removed).toEqual(["/tmp/merged-tree-fake"]);
  });

  test("fails when the test suite fails on the merged tree", async () => {
    const { code, fake } = await failsOnTreeTask("test");
    expect(code).toBe(2);
    expect(fake.tasks).toEqual([
      { cwd: "/tmp/merged-tree-fake", task: "typecheck" },
      { cwd: "/tmp/merged-tree-fake", task: "test" },
    ]);
    expect(fake.logs).toContain(
      "MERGED-TREE CHECK FAILED: PR #2583 merges into main but test fails on the merged tree",
    );
  });

  test("creates no worktree when the fetch fails", async () => {
    const fake = fakeDeps({
      command: gitByCommand({
        "fetch origin pull/2583/head main": {
          ...ok,
          stderr: "fatal: could not read from remote repository\n",
          success: false,
        },
      }),
    });
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(3);
    expectNoWorktree(fake);
    expect(fake.removed).toEqual([]);
    expect(fake.logs).toContain(
      "MERGED-TREE CHECK FAILED: cannot fetch PR #2583 or origin/main",
    );
    expect(fake.logs).toContain("fatal: could not read from remote repository");
  });

  /** One ref does not resolve, so nothing runs and the diagnostic prints. */
  const unresolvable = async (
    map: Record<string, CommandResult>,
    diagnostic: string,
  ) => {
    const fake = fakeDeps({ command: gitByCommand(map) });
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(3);
    expectNoWorktree(fake);
    expect(fake.logs).toContain(
      "MERGED-TREE CHECK FAILED: cannot resolve PR #2583 against origin/main",
    );
    expect(fake.logs).toContain(diagnostic);
  };

  test("creates no worktree when the head does not resolve", async () => {
    await unresolvable(
      {
        "rev-parse FETCH_HEAD": {
          ...ok,
          stderr: "fatal: ambiguous argument 'FETCH_HEAD'\n",
          success: false,
        },
      },
      "fatal: ambiguous argument 'FETCH_HEAD'",
    );
  });

  test("creates no worktree when the base does not resolve", async () => {
    await unresolvable(
      {
        "rev-parse FETCH_HEAD": { ...ok, stdout: "headsha\n" },
        "rev-parse origin/main": {
          ...ok,
          stderr: "fatal: ambiguous argument 'origin/main'\n",
          success: false,
        },
      },
      "fatal: ambiguous argument 'origin/main'",
    );
  });

  test("merges the fetched origin head, never a stale local branch", async () => {
    const { code, fake } = await runRefHead("feature", {
      "fetch origin refs/heads/feature main": ok,
      "rev-parse --verify feature^{commit}": {
        ...ok,
        stdout: "localsha\n",
      },
      "rev-parse FETCH_HEAD": { ...ok, stdout: "fetchedsha\n" },
      "rev-parse origin/main": { ...ok, stdout: "basesha\n" },
    });
    expect(code).toBe(0);
    expect(fake.calls).toContainEqual({
      args: ["fetch", "origin", "refs/heads/feature", "main"],
      cwd: undefined,
      program: "git",
    });
    expect(fake.calls).toContainEqual({
      args: ["merge", "--no-commit", "--no-ff", "fetchedsha"],
      cwd: "/tmp/merged-tree-fake",
      program: "git",
    });
    expect(fake.calls.some((one) => one.args.includes("localsha"))).toBe(false);
  });

  test("resolves a remote-only head from the fetch with no local branch", async () => {
    const { code, fake } = await runRefHead("new-thing", {
      "rev-parse FETCH_HEAD": { ...ok, stdout: "remoteonlysha\n" },
      "rev-parse origin/main": { ...ok, stdout: "basesha\n" },
    });
    expect(code).toBe(0);
    expect(fake.calls).toContainEqual({
      args: ["fetch", "origin", "refs/heads/new-thing", "main"],
      cwd: undefined,
      program: "git",
    });
    expect(fake.calls).toContainEqual({
      args: ["merge", "--no-commit", "--no-ff", "remoteonlysha"],
      cwd: "/tmp/merged-tree-fake",
      program: "git",
    });
  });

  test("cleans the throwaway directory when the worktree cannot be created", async () => {
    const fake = fakeDeps({
      command: gitByCommand({
        "rev-parse FETCH_HEAD": { ...ok, stdout: "headsha\n" },
        "rev-parse origin/main": { ...ok, stdout: "basesha\n" },
        "worktree add --detach /tmp/merged-tree-fake basesha": {
          ...ok,
          stderr: "fatal: cannot create worktree\n",
          success: false,
        },
      }),
    });
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(3);
    expect(fake.removed).toEqual(["/tmp/merged-tree-fake"]);
    expect(
      fake.calls.some(
        (one) =>
          one.program === "git" &&
          one.args[0] === "worktree" &&
          one.args[1] === "remove",
      ),
    ).toBe(false);
    expect(fake.logs).toContain(
      "MERGED-TREE CHECK FAILED: cannot create the trial worktree for PR #2583 into main",
    );
  });

  test("fails the check when the worktree removal fails", async () => {
    const fake = withRemoval(() =>
      Promise.resolve({
        ...ok,
        stderr: "fatal: dirty worktree\n",
        success: false,
      }),
    );
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(2);
    expect(fake.logs).toContain(
      "warning: could not remove the worktree at /tmp/merged-tree-fake: fatal: dirty worktree. Run: git worktree prune",
    );
    expectCleanupFailure(fake);
    expect(fake.removed).toEqual(["/tmp/merged-tree-fake"]);
  });

  test("fails the check when the throwaway directory cannot be removed", async () => {
    const fake = fakeDeps({
      command: gitByCommand({ ...resolvesHeads }),
      removeTree: (path) =>
        Promise.reject(new Error(`disk refuses to let go of ${path}`)),
    });
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(2);
    expect(fake.logs).toContain(
      "warning: could not remove the throwaway directory at /tmp/merged-tree-fake: disk refuses to let go of /tmp/merged-tree-fake",
    );
    expectCleanupFailure(fake);
  });

  test("collects a thrown worktree removal instead of replacing the verdict", async () => {
    const fake = withRemoval(() => Promise.reject(new Error("spawn refused")));
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(2);
    expect(fake.logs).toContain(
      "warning: could not remove the worktree at /tmp/merged-tree-fake: spawn refused. Run: git worktree prune",
    );
    expectCleanupFailure(fake);
    expect(fake.removed).toEqual(["/tmp/merged-tree-fake"]);
  });

  test("collects failures that are not Error objects", async () => {
    const fake = withRemoval(() => Promise.reject("git vanished"));
    fake.deps.removeTree = () => Promise.reject("not an error");
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(2);
    expect(fake.logs).toContain(
      "warning: could not remove the worktree at /tmp/merged-tree-fake: git vanished. Run: git worktree prune",
    );
    expect(fake.logs).toContain(
      "warning: could not remove the throwaway directory at /tmp/merged-tree-fake: not an error",
    );
  });

  test("reports a removal failure with no detail", async () => {
    const fake = withRemoval(() => Promise.resolve({ ...ok, success: false }));
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(2);
    expect(fake.logs).toContain(
      "warning: could not remove the worktree at /tmp/merged-tree-fake. Run: git worktree prune",
    );
  });

  test("cleans up and rethrows when the stripe-mock copy fails", async () => {
    const fake = fakeDeps({
      command: gitByCommand({ ...resolvesHeads }),
    });
    fake.deps.copyStripeMock = () => Promise.reject(new Error("copy refused"));
    await expect(runMergedTreeCheck(prArgs, fake.deps)).rejects.toThrow(
      "copy refused",
    );
    expect(fake.removed).toEqual(["/tmp/merged-tree-fake"]);
    expect(fake.logs.some((line) => line.startsWith("MERGED-TREE CHECK"))).toBe(
      false,
    );
  });

  test("ignores a missing directory during cleanup", async () => {
    const fake = fakeDeps({
      command: gitByCommand({ ...resolvesHeads }),
      removeTree: () =>
        Promise.reject(new Deno.errors.NotFound("no such directory")),
    });
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(0);
  });
});
