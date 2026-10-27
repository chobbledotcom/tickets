import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { RATCHET_GUIDE } from "#scripts/check-test-quality/gate.ts";
import { gateExit } from "#scripts/check-test-quality.ts";
import type { EnvironmentValues } from "#scripts/environment-values.ts";
import { withEnvironment } from "#scripts/test-environment.ts";
import { capturedCheckOutput } from "#test-utils/check-script.ts";
import { gitShow, holds, lsTree, stubRun } from "#test-utils/git-stub.ts";

const DIFF = "git diff --name-only --diff-filter=ACMR base123 -- test";
type Answers = Record<
  string,
  { code: number; stderr?: string; stdout: string }
>;

/** A head test file with one weak assertion and a way to vary it. */
const weakHeadFile = (assertion = "expect(value).toBeTruthy();"): string =>
  [
    'import { expect } from "@std/expect";',
    "",
    'Deno.test("flag", () => {',
    `  ${assertion}`,
    "});",
    "",
  ].join("\n");

/** A head test file with no weak assertions. */
const cleanHeadFile = (): string =>
  [
    'import { expect } from "@std/expect";',
    "",
    'Deno.test("exact", () => {',
    "  expect(2).toBe(2);",
    "});",
    "",
  ].join("\n");

describe("gateExit", () => {
  const output = capturedCheckOutput();

  /** Run the gate under a fixed environment. The gate emits GitHub
   * annotations only in CI, so the default pins `GITHUB_ACTIONS` off to keep
   * every run here deterministic; a CI test opts back in. */
  const runGate = async (
    headRead: (path: string) => Promise<string>,
    answers: Answers,
    environment: EnvironmentValues = { GITHUB_ACTIONS: undefined },
  ): Promise<number> => {
    output.lines.length = 0;
    return withEnvironment(environment, () =>
      gateExit(stubRun(answers), output, headRead),
    );
  };

  /** The gate must throw when a git probe fails, naming the cause. The name
   * starts with `expect`, which the quality audit counts as an assertion. */
  const expectGateRejects = async (
    answers: Answers,
    expected: RegExp,
  ): Promise<void> => {
    await expect(runGate(() => Promise.resolve(""), answers)).rejects.toThrow(
      expected,
    );
  };

  const baseAnswers = (
    base: string | undefined,
    paths = "test/a.test.ts",
  ): Answers => ({
    "git ls-files --others --exclude-standard -- test": {
      code: 0,
      stdout: "",
    },
    "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
    [DIFF]: { code: 0, stdout: `${paths}\n` },
    [lsTree("base123", "test/a.test.ts")]:
      base === undefined ? { code: 0, stdout: "" } : holds("test/a.test.ts"),
    [gitShow("base123", "test/a.test.ts")]: {
      code: 0,
      stdout: base ?? "",
    },
  });

  test("passes when the change adds no weak assertion", async () => {
    const base = weakHeadFile();
    const code = await runGate(
      () => Promise.resolve(weakHeadFile()),
      baseAnswers(base),
    );
    expect(code).toBe(0);
    expect(output.lines).toEqual([
      "The test quality gate finds no new weak assertions against origin/main.",
    ]);
  });

  test("annotates an existing weak assertion as a warning in CI", async () => {
    const code = await runGate(
      () => Promise.resolve(weakHeadFile()),
      baseAnswers(weakHeadFile()),
      { GITHUB_ACTIONS: "1" },
    );
    expect(code).toBe(0);
    expect(output.lines).toEqual([
      "::warning file=test/a.test.ts,line=4::truthiness assertion; prefer an exact value or contract-specific matcher",
      "The test quality gate finds no new weak assertions against origin/main.",
    ]);
  });

  test("fails and names a weak assertion the change adds", async () => {
    const code = await runGate(
      () => Promise.resolve(weakHeadFile()),
      baseAnswers(cleanHeadFile()),
    );
    expect(code).toBe(1);
    const joined = output.lines.join("\n");
    assertStringIncludes(joined, "test/a.test.ts:4:3");
    assertStringIncludes(
      joined,
      "truthiness assertion; prefer an exact value or contract-specific matcher",
    );
    assertStringIncludes(joined, RATCHET_GUIDE);
  });

  test("ignores a weak assertion the change only moves", async () => {
    const moved = [
      'import { expect } from "@std/expect";',
      "",
      'Deno.test("flag", () => {',
      "  const setup = true;",
      "  expect(setup).toBeTruthy();",
      "});",
      "",
    ].join("\n");
    const base = [
      'import { expect } from "@std/expect";',
      "",
      'Deno.test("flag", () => {',
      "  expect(setup).toBeTruthy();",
      "  const setup = true;",
      "});",
      "",
    ].join("\n");
    const code = await runGate(() => Promise.resolve(moved), baseAnswers(base));
    expect(code).toBe(0);
  });

  test("fails when a new test file the change adds carries a weak assertion", async () => {
    const answers: Answers = {
      "git ls-files --others --exclude-standard -- test": {
        code: 0,
        stdout: "test/new.test.ts\n",
      },
      "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
      [DIFF]: { code: 0, stdout: "" },
      [lsTree("base123", "test/new.test.ts")]: { code: 0, stdout: "" },
    };
    const code = await runGate(() => Promise.resolve(weakHeadFile()), answers);
    expect(code).toBe(1);
    assertStringIncludes(output.lines.join("\n"), "test/new.test.ts:4:3");
  });

  test("ignores a changed file that is not a test file", async () => {
    const answers: Answers = {
      "git ls-files --others --exclude-standard -- test": {
        code: 0,
        stdout: "",
      },
      "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
      [DIFF]: { code: 0, stdout: "test/helpers.ts\n" },
    };
    const code = await runGate(
      () => Promise.reject(new Error("a non-test file must not be read")),
      answers,
    );
    expect(code).toBe(0);
  });

  test("fails loudly when origin/main is missing", async () => {
    await expectGateRejects(
      {
        "git merge-base HEAD origin/main": {
          code: 128,
          stderr: "fatal: not a valid revision",
          stdout: "",
        },
      },
      /git fetch origin main/,
    );
  });

  test("surfaces a git diff failure", async () => {
    await expectGateRejects(
      {
        "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
        [DIFF]: { code: 128, stderr: "fatal: bad object", stdout: "" },
      },
      /bad object/,
    );
  });

  test("surfaces a base read failure", async () => {
    await expectGateRejects(
      {
        "git ls-files --others --exclude-standard -- test": {
          code: 0,
          stdout: "",
        },
        "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
        [DIFF]: { code: 0, stdout: "test/a.test.ts\n" },
        [lsTree("base123", "test/a.test.ts")]: holds("test/a.test.ts"),
        [gitShow("base123", "test/a.test.ts")]: {
          code: 128,
          stderr: "fatal: bad object base123",
          stdout: "",
        },
      },
      /bad object/,
    );
  });

  test("surfaces an untracked-file listing failure", async () => {
    await expectGateRejects(
      {
        "git ls-files --others --exclude-standard -- test": {
          code: 128,
          stderr: "fatal: not a git repository",
          stdout: "",
        },
        "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
        [DIFF]: { code: 0, stdout: "" },
      },
      /ls-files --others failed/,
    );
  });
});
