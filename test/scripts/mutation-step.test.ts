import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  CommandResult,
  RunCommand,
} from "../../scripts/precommit/merge-warning.ts";
import {
  type ChangedFiles,
  changedFiles,
  partitionChanged,
  runMutationStep,
  STALE_BASE_SOURCE_LIMIT,
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

/**
 * A fake git modelling base-ref resolution: `base` is the only
 * `rev-parse --verify` ref that exists (null = none), and `diff` is served for
 * the `git diff` call. Mirrors how `changedFiles` resolves a base ref then
 * diffs `base...HEAD`.
 */
const fakeGit =
  (opts: { base?: string | null; diff: CommandResult }): RunCommand =>
  (cmd) =>
    cmd[1] === "rev-parse"
      ? Promise.resolve(cmd.at(-1) === (opts.base ?? null) ? ok() : fail())
      : Promise.resolve(opts.diff);

describe("partitionChanged", () => {
  test("collects src .ts, .tsx and .js files as sources", () => {
    const { sources } = partitionChanged([
      "src/shared/dates.ts",
      "src/ui/templates/page.tsx",
      "src/ui/client/scanner.js",
    ]);
    expect(sources).toEqual([
      "src/shared/dates.ts",
      "src/ui/templates/page.tsx",
      "src/ui/client/scanner.js",
    ]);
  });

  test("collects test/*.test.ts and *.test.tsx files as tests", () => {
    const { tests } = partitionChanged([
      "test/lib/dates.test.ts",
      "test/templates/admin/attendees.test.tsx",
    ]);
    expect(tests).toEqual([
      "test/lib/dates.test.ts",
      "test/templates/admin/attendees.test.tsx",
    ]);
  });

  test("drops non-src non-test paths from both buckets", () => {
    const result = partitionChanged([
      "AGENTS.md",
      "deno.json",
      "scripts/precommit-mutation.ts",
      "src/styles/app.scss",
      "test/test-utils.ts",
    ]);
    expect(result).toEqual({ sources: [], tests: [] });
  });

  test("separates a mixed changed set into sources and tests", () => {
    const result = partitionChanged([
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

/** fakeGit wrapped to record the argv of the `git diff` call it serves, so a
 *  test can assert the base ref `changedFiles` resolved. */
const recordingGit = (
  opts: Parameters<typeof fakeGit>[0],
): { diffArgs: () => string[] | undefined; run: RunCommand } => {
  const inner = fakeGit(opts);
  let diffArgs: string[] | undefined;
  return {
    diffArgs: () => diffArgs,
    run: (cmd) => {
      if (cmd[1] === "diff") diffArgs = cmd;
      return inner(cmd);
    },
  };
};

describe("changedFiles", () => {
  test("diffs origin/main...HEAD for the branch's files", async () => {
    const git = recordingGit({ base: "origin/main", diff: ok("src/a.ts\n") });
    await changedFiles(git.run);
    expect(git.diffArgs()).toEqual([
      "git",
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "origin/main...HEAD",
    ]);
  });

  test("falls back to local main when origin/main is absent", async () => {
    const git = recordingGit({ base: "main", diff: ok("") });
    await changedFiles(git.run);
    expect(git.diffArgs()?.at(-1)).toBe("main...HEAD");
  });

  test("trims whitespace and drops blank lines, partitioned", async () => {
    const changed = await changedFiles(
      fakeGit({
        base: "origin/main",
        diff: ok("src/a.ts\n  test/a.test.ts  \n\n"),
      }),
    );
    expect(changed).toEqual({
      sources: ["src/a.ts"],
      tests: ["test/a.test.ts"],
    });
  });

  test("returns null when neither origin/main nor main exists", async () => {
    expect(await changedFiles(fakeGit({ diff: ok("src/a.ts\n") }))).toBe(null);
  });

  test("throws when the diff command fails", async () => {
    await expect(
      changedFiles(
        fakeGit({ base: "origin/main", diff: fail("bad revision") }),
      ),
    ).rejects.toThrow("bad revision");
  });
});

describe("runMutationStep", () => {
  /** Run the step over a changed set that should pass *without* invoking the
   *  mutation runner, asserting the exact log lines it emitted. */
  const expectSkip = async (
    run: RunCommand,
    expectedLogs: string[],
  ): Promise<void> => {
    const logs: string[] = [];
    let mutationRan = false;
    const code = await runMutationStep({
      log: (message) => logs.push(message),
      run,
      runMutation: () => {
        mutationRan = true;
        return Promise.resolve(0);
      },
    });
    expect(code).toBe(0);
    expect(mutationRan).toBe(false);
    expect(logs).toEqual(expectedLogs);
  };

  test("skips when there is no base ref to diff against", async () => {
    await expectSkip(fakeGit({ diff: ok("src/a.ts\ntest/a.test.ts\n") }), [
      "No origin/main or main to diff against — skipping mutation.",
    ]);
  });

  test("skips with a fetch hint when the changed set looks stale-base huge", async () => {
    const sources = Array.from(
      { length: STALE_BASE_SOURCE_LIMIT + 1 },
      (_, i) => `src/f${i}.ts`,
    );
    await expectSkip(
      fakeGit({
        base: "origin/main",
        diff: ok(`${sources.join("\n")}\ntest/a.test.ts\n`),
      }),
      [
        `${STALE_BASE_SOURCE_LIMIT + 1} changed src files — the local base ref ` +
          "looks stale. Run `git fetch origin main` and retry; skipping mutation.",
      ],
    );
  });

  test("still runs at exactly the stale-base limit", async () => {
    const sources = Array.from(
      { length: STALE_BASE_SOURCE_LIMIT },
      (_, i) => `src/f${i}.ts`,
    );
    let received: ChangedFiles | null = null;
    const code = await runMutationStep({
      log: () => {},
      run: fakeGit({
        base: "origin/main",
        diff: ok(`${sources.join("\n")}\ntest/a.test.ts\n`),
      }),
      runMutation: (files) => {
        received = files;
        return Promise.resolve(0);
      },
    });
    expect(code).toBe(0);
    expect(received?.sources.length).toBe(STALE_BASE_SOURCE_LIMIT);
  });

  test("passes without running mutation when no src files changed", async () => {
    await expectSkip(
      fakeGit({
        base: "origin/main",
        diff: ok("docs/guide.md\ntest/a.test.ts\n"),
      }),
      ["No changed src files — nothing to mutation-test."],
    );
  });

  test("skips (passing) when src changed without any test", async () => {
    await expectSkip(
      fakeGit({ base: "origin/main", diff: ok("src/a.ts\nsrc/b.ts\n") }),
      [
        "Changed src files but no changed test files — skipping mutation. " +
          "Change a test that covers them to mutation-check the change.",
      ],
    );
  });

  test("mutates the changed src against the changed tests", async () => {
    const logs: string[] = [];
    let received: ChangedFiles | null = null;
    const code = await runMutationStep({
      log: (message) => logs.push(message),
      run: fakeGit({
        base: "origin/main",
        diff: ok("src/a.ts\ntest/a.test.ts\n"),
      }),
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
      "Mutation-testing 1 changed src file(s) against 1 changed test " +
        "file(s); every mutant must be killed.",
    ]);
  });

  test("propagates a survivor failure from the mutation runner", async () => {
    const code = await runMutationStep({
      log: () => {},
      run: fakeGit({
        base: "origin/main",
        diff: ok("src/a.ts\ntest/a.test.ts\n"),
      }),
      runMutation: () => Promise.resolve(1),
    });
    expect(code).toBe(1);
  });

  test("treats 'no mutable operators' (exit 2) as a pass", async () => {
    const code = await runMutationStep({
      log: () => {},
      run: fakeGit({
        base: "origin/main",
        diff: ok("src/types.ts\ntest/a.test.ts\n"),
      }),
      runMutation: () => Promise.resolve(2),
    });
    expect(code).toBe(0);
  });
});
