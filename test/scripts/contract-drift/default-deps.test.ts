import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ContractsSchema } from "#scripts/contract-drift/dump.ts";
import { defaultDriftDeps } from "#scripts/contract-drift/run.ts";
import type { CapturedOutput } from "#scripts/process.ts";
import { projectRoot } from "#scripts/project-root.ts";

/** One dump run must succeed and print the contracts of every machine. */
const expectEveryMachineDumped = (dump: CapturedOutput): void => {
  expect(dump.success).toBe(true);
  const parsed = v.safeParse(ContractsSchema, JSON.parse(dump.stdout));
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(Object.keys(parsed.output.machines)).toHaveLength(5);
  }
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
    expectEveryMachineDumped(await deps.runBaseDump(projectRoot));
  });

  test("runs the copied dump entry in a worktree one commit back", async () => {
    const deps = defaultDriftDeps();
    const parent = await deps.git([
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD~1",
    ]);
    if (!parent.success) {
      console.log(
        "skipped: this checkout holds no parent commit, so no older tree exists to run the dump against",
      );
      return;
    }
    const dir = await deps.makeTempDir();
    const worktree = `${dir}/base`;
    const added = await deps.git([
      "worktree",
      "add",
      "--detach",
      worktree,
      parent.stdout.trim(),
    ]);
    expect(added.success).toBe(true);
    try {
      await deps.copyDumpModule(worktree);
      expectEveryMachineDumped(await deps.runBaseDump(worktree));
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
