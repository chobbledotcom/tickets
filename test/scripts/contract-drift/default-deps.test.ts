import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ContractsSchema } from "#scripts/contract-drift/dump.ts";
import { defaultDriftDeps } from "#scripts/contract-drift/run.ts";
import type { CapturedOutput } from "#scripts/process.ts";
import { projectRoot } from "#scripts/project-root.ts";

/** The machine ids one dump run printed, after the run held the dump's
 * shape. Sorted, so two runs compare as sets. */
const dumpedMachines = (dump: CapturedOutput): string[] => {
  expect(dump.success).toBe(true);
  const parsed = v.parse(ContractsSchema, JSON.parse(dump.stdout));
  return Object.keys(parsed.machines).sort();
};

describe("contract drift default dependencies", () => {
  test("captures a real git run", async () => {
    const deps = defaultDriftDeps();
    const result = await deps.git(["--version"]);
    expect(result.success).toBe(true);
    assertStringIncludes(result.stdout, "git version");
  });

  test("copies the dump module into a fresh directory", async () => {
    const deps = defaultDriftDeps();
    const dir = await deps.makeTempDir();
    await deps.copyDumpModule(dir);
    for (const file of ["dump.ts", "dump-entry.ts"]) {
      const copied = await Deno.stat(`${dir}/scripts/contract-drift/${file}`);
      expect(copied.isFile).toBe(true);
    }
    await deps.removeTree(dir);
    await expect(Deno.stat(dir)).rejects.toThrow();
  });

  test("runs the real dump entry and prints contracts", async () => {
    const deps = defaultDriftDeps();
    expect(dumpedMachines(await deps.runBaseDump(projectRoot))).toHaveLength(5);
  });

  test("runs the copied dump entry in a worktree at the merge base", async () => {
    const deps = defaultDriftDeps();
    // The copied dump must run in a tree without this branch's helpers,
    // so the worktree sits at the merge base.
    const base = await deps.git(["merge-base", "origin/main", "HEAD"]);
    if (!base.success) {
      throw new Error(
        "This checkout has no origin/main, so the base dump has no older tree to run in. Fetch origin/main or use a full checkout, then run the suite again",
      );
    }
    const dir = await deps.makeTempDir();
    const worktree = `${dir}/base`;
    const added = await deps.git([
      "worktree",
      "add",
      "--detach",
      worktree,
      base.stdout.trim(),
    ]);
    expect(added.success).toBe(true);
    try {
      const baseOwn = dumpedMachines(await deps.runBaseDump(worktree));
      await deps.copyDumpModule(worktree);
      expect(dumpedMachines(await deps.runBaseDump(worktree))).toEqual(baseOwn);
    } finally {
      await deps.git(["worktree", "remove", "--force", worktree]);
      await deps.removeTree(dir);
    }
  });

  test("dumps the head's contracts in process", async () => {
    const deps = defaultDriftDeps();
    const head = await deps.headContracts();
    expect(Object.keys(head.machines)).toHaveLength(5);
  });
});
