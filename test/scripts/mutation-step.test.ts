import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  CommandResult,
  RunCommand,
} from "../../scripts/precommit/merge-warning.ts";
import {
  partitionStaged,
  runMutationStep,
  type StagedFiles,
  stagedPaths,
} from "../../scripts/precommit/mutation-step.ts";

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stderr: "",
  stdout,
  success: true,
});

const fail = (stderr = ""): CommandResult => ({
  code: 1,
  stderr,
  stdout: "",
  success: false,
});

/** A RunCommand that always returns the same result, ignoring its args. */
const constRun =
  (result: CommandResult): RunCommand =>
  () =>
    Promise.resolve(result);

describe("partitionStaged", () => {
  test("collects src .ts and .tsx files as sources", () => {
    const { sources } = partitionStaged([
      "src/shared/dates.ts",
      "src/ui/templates/page.tsx",
    ]);
    expect(sources).toEqual([
      "src/shared/dates.ts",
      "src/ui/templates/page.tsx",
    ]);
  });

  test("collects test/*.test.ts files as tests", () => {
    const { tests } = partitionStaged([
      "test/lib/dates.test.ts",
      "test/features/auth.test.ts",
    ]);
    expect(tests).toEqual([
      "test/lib/dates.test.ts",
      "test/features/auth.test.ts",
    ]);
  });

  test("drops non-src non-test paths from both buckets", () => {
    const result = partitionStaged([
      "AGENTS.md",
      "deno.json",
      "scripts/precommit-mutation.ts",
      "src/styles/app.scss",
      "test/test-utils.ts",
    ]);
    expect(result).toEqual({ sources: [], tests: [] });
  });

  test("separates a mixed staged set into sources and tests", () => {
    const result = partitionStaged([
      "src/shared/dates.ts",
      "test/lib/dates.test.ts",
      "README.md",
    ]);
    expect(result).toEqual({
      sources: ["src/shared/dates.ts"],
      tests: ["test/lib/dates.test.ts"],
    });
  });
});

describe("stagedPaths", () => {
  test("asks git only for surviving, staged file names", async () => {
    let received: string[] = [];
    const run: RunCommand = (cmd) => {
      received = cmd;
      return Promise.resolve(ok("src/a.ts\n"));
    };
    await stagedPaths(run);
    expect(received).toEqual([
      "git",
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=ACMR",
    ]);
  });

  test("trims whitespace and drops blank lines", async () => {
    const paths = await stagedPaths(
      constRun(ok("src/a.ts\n  test/a.test.ts  \n\n")),
    );
    expect(paths).toEqual(["src/a.ts", "test/a.test.ts"]);
  });

  test("throws when git fails", async () => {
    await expect(
      stagedPaths(constRun(fail("not a git repository"))),
    ).rejects.toThrow("not a git repository");
  });
});

describe("runMutationStep", () => {
  test("passes without running mutation when no src files are staged", async () => {
    const logs: string[] = [];
    let mutationRan = false;
    const code = await runMutationStep({
      log: (message) => logs.push(message),
      run: constRun(ok("docs/guide.md\ntest/a.test.ts\n")),
      runMutation: () => {
        mutationRan = true;
        return Promise.resolve(0);
      },
    });
    expect(code).toBe(0);
    expect(mutationRan).toBe(false);
    expect(logs).toEqual(["No staged src files — nothing to mutation-test."]);
  });

  test("skips (passing) when src is staged without tests", async () => {
    const logs: string[] = [];
    let mutationRan = false;
    const code = await runMutationStep({
      log: (message) => logs.push(message),
      run: constRun(ok("src/a.ts\nsrc/b.ts\n")),
      runMutation: () => {
        mutationRan = true;
        return Promise.resolve(0);
      },
    });
    expect(code).toBe(0);
    expect(mutationRan).toBe(false);
    expect(logs).toEqual([
      "Staged src changes but no staged test files — skipping mutation. " +
        "Stage a test that covers the change to mutation-check it.",
    ]);
  });

  test("mutates the staged src against the staged tests", async () => {
    const logs: string[] = [];
    let received: StagedFiles | null = null;
    const code = await runMutationStep({
      log: (message) => logs.push(message),
      run: constRun(ok("src/a.ts\ntest/a.test.ts\n")),
      runMutation: (files) => {
        received = files;
        return Promise.resolve(0);
      },
    });
    expect(code).toBe(0);
    expect(received).toEqual({
      sources: ["src/a.ts"],
      tests: ["test/a.test.ts"],
    });
    expect(logs).toEqual([
      "Mutation-testing 1 staged src file(s) against 1 staged test " +
        "file(s); every mutant must be killed.",
    ]);
  });

  test("propagates a survivor failure from the mutation runner", async () => {
    const code = await runMutationStep({
      log: () => {},
      run: constRun(ok("src/a.ts\ntest/a.test.ts\n")),
      runMutation: () => Promise.resolve(1),
    });
    expect(code).toBe(1);
  });

  test("treats 'no mutable operators' (exit 2) as a pass", async () => {
    const code = await runMutationStep({
      log: () => {},
      run: constRun(ok("src/types.ts\ntest/a.test.ts\n")),
      runMutation: () => Promise.resolve(2),
    });
    expect(code).toBe(0);
  });
});
