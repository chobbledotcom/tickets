import { assertRejects, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ContractsSchema } from "#scripts/contract-drift/dump.ts";
import {
  type DriftDeps,
  defaultDriftDeps,
} from "#scripts/contract-drift/run.ts";
import type { CapturedOutput } from "#scripts/process.ts";
import { projectRoot } from "#scripts/project-root.ts";

/** The machine ids one dump run printed, after the run held the dump's
 * shape. Sorted, so two runs compare as sets. */
const dumpedMachines = (dump: CapturedOutput): string[] => {
  expect(dump.success).toBe(true);
  const parsed = v.parse(ContractsSchema, JSON.parse(dump.stdout));
  return Object.keys(parsed.machines).sort();
};

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const okRun = (stdout = ""): CapturedOutput => ({
  code: 0,
  stderr: "",
  stdout,
  success: true,
});
const failedRun = (stderr: string): CapturedOutput => ({
  code: 128,
  stderr,
  stdout: "",
  success: false,
});
const NO_MAIN = failedRun("fatal: ambiguous argument 'origin/main'");

/** A git for the base tests. It records every call in `calls` and answers
 * from `answers`, keyed by the joined command. An unmatched command
 * throws, so an unexpected call fails the test loudly. */
const fakeGit =
  (
    calls: string[][],
    answers: Record<string, () => CapturedOutput>,
  ): DriftDeps["git"] =>
  async (args) => {
    calls.push([...args]);
    const answer = answers[args.join(" ")];
    if (answer === undefined) {
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    }
    return answer();
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
    const base = await deps.mergeBase();
    const dir = await deps.makeTempDir();
    const worktree = `${dir}/base`;
    const added = await deps.git([
      "worktree",
      "add",
      "--detach",
      worktree,
      base,
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

  test("resolves the base without a fetch when the checkout holds origin/main", async () => {
    const calls: string[][] = [];
    const deps = defaultDriftDeps({
      git: fakeGit(calls, {
        "merge-base origin/main HEAD": () => okRun(`${BASE_SHA}\n`),
      }),
    });
    expect(await deps.mergeBase()).toBe(BASE_SHA);
    expect(calls).toEqual([["merge-base", "origin/main", "HEAD"]]);
  });

  test("fetches main when the checkout holds no origin/main", async () => {
    const calls: string[][] = [];
    let fetchedMain = false;
    const deps = defaultDriftDeps({
      git: fakeGit(calls, {
        "fetch origin main:refs/remotes/origin/main": () => {
          fetchedMain = true;
          return okRun();
        },
        "merge-base origin/main HEAD": () =>
          fetchedMain ? okRun(`${BASE_SHA}\n`) : NO_MAIN,
      }),
    });
    expect(await deps.mergeBase()).toBe(BASE_SHA);
    expect(calls).toEqual([
      ["merge-base", "origin/main", "HEAD"],
      ["fetch", "origin", "main:refs/remotes/origin/main"],
      ["merge-base", "origin/main", "HEAD"],
    ]);
  });

  test("fetches the full history when main alone brings no origin/main", async () => {
    const calls: string[][] = [];
    let unshallowed = false;
    const deps = defaultDriftDeps({
      git: fakeGit(calls, {
        "fetch --unshallow origin +refs/heads/*:refs/remotes/origin/*": () => {
          unshallowed = true;
          return okRun();
        },
        "fetch origin main:refs/remotes/origin/main": () => okRun(),
        "merge-base origin/main HEAD": () =>
          unshallowed ? okRun(`${BASE_SHA}\n`) : NO_MAIN,
        "rev-parse --is-shallow-repository": () => okRun("true\n"),
      }),
    });
    expect(await deps.mergeBase()).toBe(BASE_SHA);
    expect(calls).toEqual([
      ["merge-base", "origin/main", "HEAD"],
      ["fetch", "origin", "main:refs/remotes/origin/main"],
      ["merge-base", "origin/main", "HEAD"],
      ["rev-parse", "--is-shallow-repository"],
      ["fetch", "--unshallow", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      ["merge-base", "origin/main", "HEAD"],
    ]);
  });

  test("throws when a complete checkout still holds no origin/main", async () => {
    const calls: string[][] = [];
    const deps = defaultDriftDeps({
      git: fakeGit(calls, {
        "fetch origin main:refs/remotes/origin/main": () => okRun(),
        "merge-base origin/main HEAD": () => NO_MAIN,
        "rev-parse --is-shallow-repository": () => okRun("false\n"),
      }),
    });
    await assertRejects(
      () => deps.mergeBase(),
      Error,
      "This checkout has no origin/main even after a fetch, so the base dump has no older tree to run in. Fetch origin/main or use a full checkout, then run the suite again",
    );
    expect(calls).toEqual([
      ["merge-base", "origin/main", "HEAD"],
      ["fetch", "origin", "main:refs/remotes/origin/main"],
      ["merge-base", "origin/main", "HEAD"],
      ["rev-parse", "--is-shallow-repository"],
    ]);
  });

  test("throws when the full history still holds no origin/main", async () => {
    const calls: string[][] = [];
    const deps = defaultDriftDeps({
      git: fakeGit(calls, {
        "fetch --unshallow origin +refs/heads/*:refs/remotes/origin/*": () =>
          okRun(),
        "fetch origin main:refs/remotes/origin/main": () => okRun(),
        "merge-base origin/main HEAD": () => NO_MAIN,
        "rev-parse --is-shallow-repository": () => okRun("true\n"),
      }),
    });
    await assertRejects(
      () => deps.mergeBase(),
      Error,
      "This checkout has no origin/main even after a fetch, so the base dump has no older tree to run in. Fetch origin/main or use a full checkout, then run the suite again",
    );
    expect(calls).toEqual([
      ["merge-base", "origin/main", "HEAD"],
      ["fetch", "origin", "main:refs/remotes/origin/main"],
      ["merge-base", "origin/main", "HEAD"],
      ["rev-parse", "--is-shallow-repository"],
      ["fetch", "--unshallow", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      ["merge-base", "origin/main", "HEAD"],
    ]);
  });

  test("dumps the head's contracts in process", async () => {
    const deps = defaultDriftDeps();
    const head = await deps.headContracts();
    expect(Object.keys(head.machines)).toHaveLength(5);
  });
});
