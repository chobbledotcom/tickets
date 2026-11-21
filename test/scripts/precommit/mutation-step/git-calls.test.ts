import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RunCommand } from "#scripts/precommit/git.ts";
import {
  changedFiles,
  codeShape,
  runMutationStep,
} from "#scripts/precommit/mutation-step.ts";
import type { CapturedOutput } from "#scripts/process.ts";
import {
  type FakeGitOptions,
  fakeGit,
} from "#test/scripts/precommit/fake-git.ts";
import { capturedFail, capturedOk } from "#test-utils/captured-output.ts";

/** A fake git that records each command it gets. */
const recorded = (opts: FakeGitOptions) => {
  const calls: string[][] = [];
  const inner = fakeGit(opts);
  const run: RunCommand = (cmd) => {
    calls.push([...cmd]);
    return inner(cmd);
  };
  return { calls, run };
};

describe("the git commands that changedFiles sends", () => {
  test("lists the deleted paths against the base", async () => {
    const { calls, run } = recorded({
      base: "origin/main",
      diff: capturedOk(""),
    });
    await changedFiles(run);
    expect(calls).toContainEqual([
      "git",
      "diff",
      "--name-only",
      "--diff-filter=D",
      "origin/main...HEAD",
    ]);
  });

  test("asks whether HEAD holds each source that a deleted test mirrors, nearest first", async () => {
    const { calls, run } = recorded({
      base: "origin/main",
      deleted: capturedOk("test/shared/dates.test.ts\n"),
      diff: capturedOk(""),
    });
    await changedFiles(run);
    expect(calls.filter((cmd) => cmd[1] === "cat-file")).toEqual(
      [
        "src/shared/dates.ts",
        "src/shared/dates.tsx",
        "src/shared.ts",
        "src/shared.tsx",
      ].map((path) => ["git", "cat-file", "-e", `HEAD:${path}`]),
    );
  });

  test("shows each changed source at the base and at HEAD", async () => {
    const { calls, run } = recorded({
      base: "origin/main",
      diff: capturedOk("src/a.ts\n"),
    });
    await changedFiles(run);
    expect(calls.filter((cmd) => cmd[1] === "show")).toEqual([
      ["git", "show", "origin/main:src/a.ts"],
      ["git", "show", "HEAD:src/a.ts"],
    ]);
  });
});

/** A `git show` that answers `before` for the base and `after` for HEAD. */
const showing =
  (before: CapturedOutput, after: CapturedOutput) => (revPath: string) =>
    revPath.startsWith("HEAD:") ? after : before;

describe("which sources count as changed", () => {
  const changedBy = async (show: (revPath: string) => CapturedOutput) =>
    (
      await changedFiles(
        fakeGit({ base: "origin/main", diff: capturedOk("src/a.ts\n"), show }),
      )
    )?.sources;

  test("a source that one revision cannot show counts as changed, even when the texts match", async () => {
    const same = "const a = 1;\n";
    const missing = { ...capturedFail(1, "missing"), stdout: same };
    expect(await changedBy(showing(capturedOk(same), missing))).toEqual([
      "src/a.ts",
    ]);
  });

  test("a source whose revisions differ only in comments does not count", async () => {
    const show = showing(
      capturedOk("const a = 1;\n"),
      capturedOk("const a = 1; // new note\n"),
    );
    expect(await changedBy(show)).toEqual([]);
  });
});

/** Each case: a name, the text, and the shape that it keeps. */
const SHAPES: [string, string, string][] = [
  [
    "keeps each non-blank line, trimmed at the end, joined by a newline",
    "a\n\n   \nb  \n",
    "a\nb",
  ],
  [
    "cuts out every comment and keeps the code between them",
    "x /* one */ y /* two */ z",
    "x  y  z",
  ],
];

describe("codeShape", () => {
  for (const [name, text, shape] of SHAPES) {
    test(name, () => expect(codeShape(text)).toBe(shape));
  }
});

describe("runMutationStep", () => {
  const run = fakeGit({ base: "origin/main", diff: capturedOk("src/a.ts\n") });

  const stepWith = async (tests: string[], code: number) => {
    const logs: string[] = [];
    const exit = await runMutationStep({
      allTestFiles: () => Promise.resolve(tests),
      log: (message) => logs.push(message),
      run,
      runMutation: () => Promise.resolve(code),
    });
    return { exit, logs };
  };

  test("says that each source needs a test at its mirror path when none is selected", async () => {
    const { logs } = await stepWith([], 0);
    expect(logs).toEqual([
      "Mutation-testing 1 changed src file(s); each one needs a test at its mirror path.",
    ]);
  });

  test("passes the run's exit code through", async () => {
    expect((await stepWith(["test/a.test.ts"], 1)).exit).toBe(1);
  });

  test("passes when the run finds no mutable operator (exit 2)", async () => {
    expect((await stepWith(["test/a.test.ts"], 2)).exit).toBe(0);
  });
});
