import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ParsedArgs } from "#scripts/check-merged-tree/args.ts";
import {
  type CommandResult,
  type MergeTreeDeps,
  runMergedTreeCheck,
} from "#scripts/check-merged-tree/run.ts";

const ok: CommandResult = { stderr: "", stdout: "", success: true };

type Recorded = {
  args: readonly string[];
  cwd: string | undefined;
  program: string;
};

interface Fake {
  calls: Recorded[];
  copied: string[];
  logs: string[];
  removed: string[];
  tasks: { cwd: string; task: string }[];
}

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
): Fake & { deps: MergeTreeDeps } => {
  const calls: Recorded[] = [];
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
      return Promise.resolve(
        overrides.denoTask ? overrides.denoTask(task, cwd) : 0,
      );
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
        "merge --no-commit --no-ff headsha": {
          ...ok,
          stderr: "CONFLICT (content): Merge conflict in src/a.ts\n",
          success: false,
        },
        "rev-parse --verify feature^{commit}": { ...ok, stdout: "headsha\n" },
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
    expect(fake.calls.some((one) => one.program === "makeTempDir")).toBe(false);
    expect(fake.removed).toEqual([]);
    expect(fake.calls.some((one) => one.args[0] === "worktree")).toBe(false);
    expect(fake.logs).toContain(
      "MERGED-TREE CHECK FAILED: cannot fetch PR #2583 or origin/main",
    );
    expect(fake.logs).toContain("fatal: could not read from remote repository");
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

  test("warns and still cleans up when the worktree removal fails", async () => {
    const fake = fakeDeps({
      command: (program, args) => {
        if (
          program === "git" &&
          args[0] === "worktree" &&
          args[1] === "remove"
        ) {
          return Promise.resolve({ ...ok, success: false });
        }
        if (program === "git" && args.join(" ") === "rev-parse FETCH_HEAD") {
          return Promise.resolve({ ...ok, stdout: "headsha\n" });
        }
        if (program === "git" && args.join(" ") === "rev-parse origin/main") {
          return Promise.resolve({ ...ok, stdout: "basesha\n" });
        }
        return Promise.resolve(ok);
      },
    });
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(0);
    expect(fake.logs).toContain(
      "warning: could not remove the worktree at /tmp/merged-tree-fake. Run: git worktree prune",
    );
    expect(fake.removed).toEqual(["/tmp/merged-tree-fake"]);
  });

  test("ignores a missing directory during cleanup", async () => {
    const fake = fakeDeps({
      command: gitByCommand({
        "rev-parse FETCH_HEAD": { ...ok, stdout: "headsha\n" },
        "rev-parse origin/main": { ...ok, stdout: "basesha\n" },
      }),
      removeTree: () =>
        Promise.reject(new Deno.errors.NotFound("no such directory")),
    });
    const code = await runMergedTreeCheck(prArgs, fake.deps);
    expect(code).toBe(0);
  });
});
