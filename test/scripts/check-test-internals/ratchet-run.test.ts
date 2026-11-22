import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ratchetExit } from "#scripts/check-test-internals/ratchet-run.ts";
import { REGISTRY_PATH } from "#scripts/check-test-internals/run.ts";
import { capturedCheckOutput } from "#test-utils/check-script.ts";
import {
  type GitStubAnswer,
  gitShow,
  holds,
  lsTree,
  stubRun,
} from "#test-utils/git-stub.ts";

describe("ratchetExit", () => {
  const output = capturedCheckOutput();

  const stubFor = (baseText: string | undefined) => {
    const answers: Record<string, GitStubAnswer> = {
      "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
      [lsTree("base123", REGISTRY_PATH)]:
        baseText === undefined ? { code: 0, stdout: "" } : holds(REGISTRY_PATH),
    };
    if (baseText !== undefined) {
      answers[gitShow("base123", REGISTRY_PATH)] = {
        code: 0,
        stdout: baseText,
      };
    }
    return stubRun(answers);
  };

  const exitFor = async (
    headText: string,
    baseText: string | undefined,
  ): Promise<number> => {
    output.lines.length = 0;
    return await ratchetExit({
      output,
      readRegistryText: () => Promise.resolve(headText),
      run: stubFor(baseText),
    });
  };

  test("passes a registry that the base holds at the same counts", async () => {
    expect(await exitFor('{"test/a.ts":1}', '{"test/a.ts":1}')).toBe(0);
    expect(output.lines).toEqual([
      "No test file holds more counted imports than the merge base on origin/main.",
    ]);
  });

  test("passes a registry that the base does not hold yet", async () => {
    expect(await exitFor('{"test/a.ts":4}', undefined)).toBe(0);
  });

  test("fails a count that rises above the base", async () => {
    expect(await exitFor('{"test/a.ts":2}', '{"test/a.ts":1}')).toBe(1);
    expect(output.lines[0]).toContain("test/a.ts [risen]");
    expect(output.lines.at(-1)).toBe(
      '\n1 test-internals-ratchet issue(s) found. See "Keep tests on the public surface" in AGENTS.md.',
    );
  });

  test("stops when the merge base is missing", async () => {
    await expect(
      ratchetExit({
        output,
        readRegistryText: () => Promise.resolve("{}"),
        run: stubRun({
          "git merge-base HEAD origin/main": { code: 1, stdout: "" },
        }),
      }),
    ).rejects.toThrow("test-internals ratchet needs origin/main");
  });
});
