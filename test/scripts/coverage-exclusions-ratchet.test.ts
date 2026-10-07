// test-groups: run-alone — see the marker comment on
// check-coverage-exclusions.test.ts.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  EXCLUSIONS_PATH,
  LEGACY_PATH,
  RATCHET_GUIDE,
} from "#scripts/check-coverage-exclusions/exclusion-ratchet.ts";
import {
  baseEntries,
  ratchetExit,
} from "#scripts/check-coverage-exclusions/ratchet-run.ts";
import type { CapturedOutput } from "#scripts/process.ts";

/** A RunCommand stub that answers a fixed map of git invocations. */
const stubRun =
  (answers: Record<string, { code: number; stdout: string }>) =>
  (cmd: string[]): Promise<CapturedOutput> => {
    const key = cmd.join(" ");
    const answer = answers[key];
    if (!answer) return Promise.reject(new Error(`unexpected command: ${key}`));
    return Promise.resolve({
      ...answer,
      stderr: "",
      success: answer.code === 0,
    });
  };

const gitShow = (revision: string, path: string) =>
  `git show ${revision}:${path}`;

const module = (entries: string[]): string =>
  `${entries.map((entry) => `  "${entry}",`).join("\n")}\n`;

describe("baseEntries", () => {
  test("reads the data module at the merge base", async () => {
    const run = stubRun({
      [gitShow("base123", EXCLUSIONS_PATH)]: {
        code: 0,
        stdout: module(["src/a.ts"]),
      },
    });
    expect(await baseEntries(run, "base123")).toEqual(["src/a.ts"]);
  });

  test("falls back to the gate module the list moved out of", async () => {
    const run = stubRun({
      [gitShow("base123", EXCLUSIONS_PATH)]: { code: 128, stdout: "" },
      [gitShow("base123", LEGACY_PATH)]: {
        code: 0,
        stdout: module(["src/old.ts"]),
      },
    });
    expect(await baseEntries(run, "base123")).toEqual(["src/old.ts"]);
  });

  test("answers an empty base when neither file exists there", async () => {
    const run = stubRun({
      [gitShow("base123", EXCLUSIONS_PATH)]: { code: 128, stdout: "" },
      [gitShow("base123", LEGACY_PATH)]: { code: 128, stdout: "" },
    });
    expect(await baseEntries(run, "base123")).toEqual([]);
  });
});

describe("ratchetExit", () => {
  const lines: string[] = [];
  const output = {
    log: (line: string) => lines.push(line),
    logError: (line: string) => lines.push(line),
  };

  /** Run the ratchet over `head` against a base that holds `base`, with the
   * report lines collected for the assertions. */
  const exitFor = async (head: string[], base: string[]): Promise<number> => {
    lines.length = 0;
    const run = stubRun({
      "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
      [gitShow("base123", EXCLUSIONS_PATH)]: {
        code: 0,
        stdout: module(base),
      },
    });
    return ratchetExit(run, module(head), output);
  };

  test("exits 0 and reports nothing added on a clean list", async () => {
    expect(await exitFor(["src/a.ts"], ["src/a.ts"])).toBe(0);
    expect(lines).toEqual([
      "The coverage exclusion list adds nothing against origin/main.",
    ]);
  });

  test("exits 1 and names each added entry", async () => {
    expect(await exitFor(["src/a.ts", "src/new.ts"], ["src/a.ts"])).toBe(1);
    expect(lines.join("\n")).toContain("src/new.ts");
    expect(lines.join("\n")).toContain(RATCHET_GUIDE);
  });

  test("fails loudly when origin/main is missing", async () => {
    lines.length = 0;
    const run = stubRun({
      "git merge-base HEAD origin/main": { code: 128, stdout: "" },
    });
    await expect(ratchetExit(run, module([]), output)).rejects.toThrow(
      /git fetch origin main/,
    );
  });
});
