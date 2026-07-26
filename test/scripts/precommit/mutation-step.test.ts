import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { CommandResult, RunCommand } from "#scripts/precommit/git.ts";
import {
  type ChangedFiles,
  changedFiles,
  MUTATION_NOTICE_PREFIX,
  mutationNoticeSummary,
  partitionChanged,
  runMutationStep,
  STALE_BASE_SOURCE_LIMIT,
} from "#scripts/precommit/mutation-step.ts";

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

  test("collects direct tests and Cucumber Features as tests", () => {
    const { tests } = partitionChanged([
      "test/lib/dates.test.ts",
      "test/templates/admin/attendees.test.tsx",
      "specs/payments/capacity.feature",
      "test/specs/steps/payment-capacity.ts",
      "test/specs/support/hooks.ts",
    ]);
    expect(tests).toEqual([
      "test/lib/dates.test.ts",
      "test/templates/admin/attendees.test.tsx",
      "specs/payments/capacity.feature",
      "test/specs/steps/payment-capacity.ts",
      "test/specs/support/hooks.ts",
    ]);
  });

  test("drops non-src non-test paths from both buckets", () => {
    const result = partitionChanged([
      "AGENTS.md",
      "deno.json",
      "scripts/precommit-mutation.ts",
      "src/styles/app.scss",
      "test/test-utils/db.ts",
    ]);
    expect(result).toEqual({ sources: [], tests: [] });
  });

  test("ignores a test-shaped file outside the test tree", () => {
    expect(partitionChanged(["e2e-payments/src/tunnel.test.ts"])).toEqual({
      sources: [],
      tests: [],
    });
  });

  test("ignores a non-TypeScript file inside the Cucumber support tree", () => {
    expect(partitionChanged(["test/specs/support/fixture.json"])).toEqual({
      sources: [],
      tests: [],
    });
  });

  test("ignores a non-Feature file inside the specs tree", () => {
    expect(partitionChanged(["specs/README.md"])).toEqual({
      sources: [],
      tests: [],
    });
  });

  test("ignores a Feature file outside the specs tree", () => {
    expect(partitionChanged(["docs/tour.feature"])).toEqual({
      sources: [],
      tests: [],
    });
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
): {
  calls: () => string[][];
  diffArgs: () => string[] | undefined;
  run: RunCommand;
} => {
  const inner = fakeGit(opts);
  const calls: string[][] = [];
  return {
    calls: () => calls,
    diffArgs: () => calls.find((cmd) => cmd[1] === "diff"),
    run: (cmd) => {
      calls.push([...cmd]);
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

  test("asks git whether each candidate base ref exists", async () => {
    const git = recordingGit({ base: "main", diff: ok("") });
    await changedFiles(git.run);
    expect(git.calls().slice(0, 2)).toEqual([
      ["git", "rev-parse", "--verify", "--quiet", "origin/main"],
      ["git", "rev-parse", "--verify", "--quiet", "main"],
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

  test("returns null on a shallow clone with no merge base", async () => {
    const changed = await changedFiles(
      fakeGit({
        base: "origin/main",
        diff: fail("fatal: origin/main...HEAD: no merge base"),
      }),
    );
    expect(changed).toBe(null);
  });

  test("throws when the diff fails for any other reason", async () => {
    await expect(
      changedFiles(
        fakeGit({ base: "origin/main", diff: fail("bad revision") }),
      ),
    ).rejects.toThrow("bad revision");
  });
});

describe("mutationNoticeSummary", () => {
  test("joins the notice lines and drops the rest", () => {
    const stdout = [
      "Running baseline tests…",
      `${MUTATION_NOTICE_PREFIX}stale base, run git fetch`,
      "..........",
      `${MUTATION_NOTICE_PREFIX}no changed tests`,
    ].join("\n");
    expect(mutationNoticeSummary(stdout)).toBe(
      `${MUTATION_NOTICE_PREFIX}stale base, run git fetch\n` +
        `${MUTATION_NOTICE_PREFIX}no changed tests`,
    );
  });

  test("returns a lone notice on its own", () => {
    expect(
      mutationNoticeSummary(
        ["baseline ok", `${MUTATION_NOTICE_PREFIX}stale base`].join("\n"),
      ),
    ).toBe(`${MUTATION_NOTICE_PREFIX}stale base`);
  });

  test("returns undefined when there are no notices", () => {
    expect(mutationNoticeSummary("All mutants were detected.\n")).toBe(
      undefined,
    );
  });
});

describe("runMutationStep", () => {
  /** Run the step over a changed set that should pass *without* invoking the
   *  mutation runner, asserting the exact log lines it emitted. */
  const expectSkip = async (
    run: RunCommand,
    expectedLogs: string[],
    testFiles: string[] = [],
  ): Promise<void> => {
    const logs: string[] = [];
    let mutationRan = false;
    const code = await runMutationStep({
      allTestFiles: () => Promise.resolve(testFiles),
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

  test("skips with a notice when the diff cannot be scoped", async () => {
    await expectSkip(fakeGit({ diff: ok("src/a.ts\ntest/a.test.ts\n") }), [
      `${MUTATION_NOTICE_PREFIX}no base commit to diff against — missing ` +
        "origin/main/main, or a shallow clone with no merge base. If shallow, " +
        "run `git fetch --unshallow`; skipping mutation.",
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
        `${MUTATION_NOTICE_PREFIX}${STALE_BASE_SOURCE_LIMIT + 1} changed src ` +
          "files — the local base ref looks stale. Run `git fetch origin main` " +
          "and retry; skipping mutation.",
      ],
    );
  });

  test("still runs at exactly the stale-base limit", async () => {
    const sources = Array.from(
      { length: STALE_BASE_SOURCE_LIMIT },
      (_, i) => `src/f${i}.ts`,
    );
    let mutatedSources = -1;
    const code = await runMutationStep({
      allTestFiles: () => Promise.resolve(["test/f0.test.ts"]),
      log: () => {},
      run: fakeGit({
        base: "origin/main",
        diff: ok(`${sources.join("\n")}\ntest/a.test.ts\n`),
      }),
      runMutation: (files) => {
        mutatedSources = files.sources.length;
        return Promise.resolve(0);
      },
    });
    expect(code).toBe(0);
    expect(mutatedSources).toBe(STALE_BASE_SOURCE_LIMIT);
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

  test("skips when changed sources have no matching tests", async () => {
    await expectSkip(
      fakeGit({ base: "origin/main", diff: ok("src/a.ts\nsrc/b.ts\n") }),
      [
        `${MUTATION_NOTICE_PREFIX}changed src files but no matching test files ` +
          "— skipping mutation.",
      ],
    );
  });

  test("mutates changed src against every matching direct test", async () => {
    const logs: string[] = [];
    let received: ChangedFiles | null = null;
    const code = await runMutationStep({
      allTestFiles: () =>
        Promise.resolve(["test/a.test.ts", "test/a/extra.test.ts"]),
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
      tests: ["test/a.test.ts", "test/a/extra.test.ts"],
    });
    expect(logs).toEqual([
      "Mutation-testing 1 changed src file(s) against 2 selected test " +
        "file(s); every mutant must be killed.",
    ]);
  });

  test("propagates a survivor failure from the mutation runner", async () => {
    const code = await runMutationStep({
      allTestFiles: () => Promise.resolve(["test/a.test.ts"]),
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
      allTestFiles: () => Promise.resolve(["test/types.test.ts"]),
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
