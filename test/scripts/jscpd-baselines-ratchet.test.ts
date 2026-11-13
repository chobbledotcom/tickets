import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  baselineFileNames,
  baselinePathsNamed,
  fingerprintCounts,
  RATCHET_GUIDE,
  riseFindings,
  unreadBaselineFindings,
} from "#scripts/check-jscpd-baselines/baseline-ratchet.ts";
import {
  type BaselineFile,
  baselineFiles,
  ratchetExit,
  taskBaselines,
} from "#scripts/check-jscpd-baselines/ratchet-run.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { capturedCheckOutput } from "#test-utils/check-script.ts";
import {
  type GitStubAnswer,
  gitShow,
  holds,
  lsTree,
  stubRun,
} from "#test-utils/git-stub.ts";

const BASELINE = ".jscpd.baseline.json";

/** A baseline file's text, in the shape jscpd writes. */
const baseline = (counts: Record<string, number>): string =>
  JSON.stringify({ fingerprints: counts, version: 1 });

describe("baselineFileNames", () => {
  test("keeps the root baseline files and sorts them", () => {
    expect(
      baselineFileNames([
        ".jscpd.test-baseline.json",
        ".jscpd.json",
        "deno.json",
        ".jscpd.renamed-baseline.json",
        ".jscpd.baseline.json",
        ".jscpd.test.json",
      ]),
    ).toEqual([
      ".jscpd.baseline.json",
      ".jscpd.renamed-baseline.json",
      ".jscpd.test-baseline.json",
    ]);
  });

  test("keeps nothing when the root holds no baseline", () => {
    expect(baselineFileNames(["deno.json", ".jscpd.specs.json"])).toEqual([]);
  });
});

describe("baselinePathsNamed", () => {
  test("reads the baseline of every scan task, once each, in path order", () => {
    expect(
      baselinePathsNamed({
        "check:copy": "deno run -A scripts/check-copy.ts",
        cpd:
          "deno run -A scripts/cpd.ts --config .jscpd.json " +
          "--baseline .jscpd.test-baseline.json && deno run -A scripts/cpd.ts " +
          "--config .jscpd.test.json --baseline .jscpd.test-baseline.json",
        "cpd:helpers":
          "deno run -A scripts/cpd.ts --config .jscpd.helpers.json " +
          "--baseline=.jscpd.helpers-baseline.json",
        "cpd:renamed":
          "deno run -A scripts/cpd.ts --config .jscpd.renamed.json " +
          "--baseline .jscpd.baseline.json",
      }),
    ).toEqual([
      ".jscpd.baseline.json",
      ".jscpd.helpers-baseline.json",
      ".jscpd.test-baseline.json",
    ]);
  });

  test("keeps nothing when no task runs a scan", () => {
    expect(baselinePathsNamed({ test: "deno task test" })).toEqual([]);
  });
});

describe("unreadBaselineFindings", () => {
  test("passes when the scans name only baselines the ratchet reads", () => {
    expect(
      unreadBaselineFindings(
        [".jscpd.baseline.json"],
        [".jscpd.baseline.json", ".jscpd.test-baseline.json"],
      ),
    ).toEqual([]);
  });

  test("names a scan baseline outside the root pattern, in path order", () => {
    expect(
      unreadBaselineFindings(
        [".jscpd.zzz-baseline.json", "scripts/jscpd/aaa-baseline.json"],
        [".jscpd.baseline.json"],
      ),
    ).toEqual([
      ".jscpd.zzz-baseline.json [unread-baseline]: is a scan baseline that " +
        "this check cannot read — keep the baseline in the repository root, " +
        "named .jscpd.<scan>-baseline.json",
      "scripts/jscpd/aaa-baseline.json [unread-baseline]: is a scan baseline " +
        "that this check cannot read — keep the baseline in the repository " +
        "root, named .jscpd.<scan>-baseline.json",
    ]);
  });
});

describe("fingerprintCounts", () => {
  test("reads one count per fingerprint", () => {
    expect(fingerprintCounts(BASELINE, baseline({ aaa: 1, bbb: 3 }))).toEqual({
      aaa: 1,
      bbb: 3,
    });
  });

  test("refuses text that is not JSON, naming the file", () => {
    expect(() => fingerprintCounts(BASELINE, "{,}")).toThrow(
      `${BASELINE} does not hold JSON`,
    );
  });

  test("refuses a file that is not a baseline, naming the file", () => {
    expect(() => fingerprintCounts(BASELINE, '{"version": 1}')).toThrow(
      `${BASELINE} does not hold the shape jscpd writes`,
    );
  });

  test("refuses a clone count above a whole number", () => {
    expect(() =>
      fingerprintCounts(BASELINE, JSON.stringify({ fingerprints: { a: 1.5 } })),
    ).toThrow(`${BASELINE} does not hold the shape jscpd writes`);
  });
});

describe("riseFindings", () => {
  for (const [name, head, base] of [
    ["passes when the clone total matches the base", { aaa: 1 }, { aaa: 1 }],
    [
      "passes a clone the branch removed and one it lowered",
      { aaa: 1 },
      { aaa: 2, bbb: 1 },
    ],
    [
      "passes a clone whose fingerprint changed",
      { zzz: 2 },
      { aaa: 1, bbb: 1 },
    ],
  ] as const) {
    test(name, () => {
      expect(riseFindings(BASELINE, baseline(head), baseline(base))).toEqual(
        [],
      );
    });
  }

  test("names a clone total above the base's", () => {
    expect(
      riseFindings(
        BASELINE,
        baseline({ aaa: 2, zzz: 1 }),
        baseline({ aaa: 2 }),
      ),
    ).toEqual([
      `${BASELINE} [raised-clones]: accepts 3 clone(s), up from 2 — merge the ` +
        "duplicated code, then lower the baseline with --update",
    ]);
  });

  test("fails a new baseline that accepts clones", () => {
    expect(
      riseFindings(BASELINE, baseline({ aaa: 3, bbb: 1 }), undefined),
    ).toEqual([
      `${BASELINE} [added-baseline]: is a new baseline that accepts 4 ` +
        "clone(s) — merge the duplicated code before you add the scan",
    ]);
  });

  test("passes a new baseline that accepts no clone", () => {
    expect(riseFindings(BASELINE, baseline({}), undefined)).toEqual([]);
  });

  test("passes a new baseline whose recorded counts are zero", () => {
    expect(riseFindings(BASELINE, baseline({ aaa: 0 }), undefined)).toEqual([]);
  });
});

describe("ratchetExit", () => {
  const output = capturedCheckOutput();

  /** A git stub that holds `base` at the merge base: text, or undefined when
   * the base holds no such file. */
  const stubFor = (base: Record<string, string | undefined>) => {
    const answers: Record<string, GitStubAnswer> = {
      "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
    };
    for (const [path, text] of Object.entries(base)) {
      answers[lsTree("base123", path)] =
        text === undefined ? { code: 0, stdout: "" } : holds(path);
      if (text !== undefined) {
        answers[gitShow("base123", path)] = { code: 0, stdout: text };
      }
    }
    return stubRun(answers);
  };

  const exitFor = async (
    files: BaselineFile[],
    base: Record<string, string | undefined>,
    named: string[] = files.map(({ path }) => path),
  ): Promise<number> => {
    output.lines.length = 0;
    return await ratchetExit({
      output,
      readBaselines: () => Promise.resolve(files),
      readNamedBaselines: () => Promise.resolve(named),
      run: stubFor(base),
    });
  };

  test("passes when no baseline rose", async () => {
    expect(
      await exitFor([{ path: BASELINE, text: baseline({ aaa: 1 }) }], {
        [BASELINE]: baseline({ aaa: 1 }),
      }),
    ).toBe(0);
    expect(output.lines).toEqual([
      "No jscpd baseline accepts more clones than the merge base on origin/main.",
    ]);
  });

  test("passes when the tree holds no baseline", async () => {
    expect(await exitFor([], {})).toBe(0);
  });

  test("fails on a baseline that accepts more clones than the base", async () => {
    expect(
      await exitFor(
        [
          { path: BASELINE, text: baseline({ aaa: 1 }) },
          {
            path: ".jscpd.renamed-baseline.json",
            text: baseline({ bbb: 1 }),
          },
        ],
        {
          [BASELINE]: baseline({ aaa: 1 }),
          ".jscpd.renamed-baseline.json": baseline({}),
        },
      ),
    ).toBe(1);
    expect(output.lines).toEqual([
      ".jscpd.renamed-baseline.json [raised-clones]: accepts 1 clone(s), up " +
        "from 0 — merge the duplicated code, then lower the baseline with " +
        "--update",
      `\n1 jscpd-baseline issue(s) found. See ${RATCHET_GUIDE}.`,
    ]);
  });

  test("fails on a baseline the merge base does not hold", async () => {
    expect(
      await exitFor([{ path: BASELINE, text: baseline({ aaa: 1 }) }], {
        [BASELINE]: undefined,
      }),
    ).toBe(1);
    expect(output.lines).toEqual([
      `${BASELINE} [added-baseline]: is a new baseline that accepts 1 clone(s) ` +
        "— merge the duplicated code before you add the scan",
      `\n1 jscpd-baseline issue(s) found. See ${RATCHET_GUIDE}.`,
    ]);
  });

  test("fails on a scan baseline the ratchet cannot read", async () => {
    expect(
      await exitFor(
        [{ path: BASELINE, text: baseline({}) }],
        { [BASELINE]: baseline({}) },
        [BASELINE, "scripts/jscpd/other-baseline.json"],
      ),
    ).toBe(1);
    expect(output.lines).toEqual([
      "scripts/jscpd/other-baseline.json [unread-baseline]: is a scan " +
        "baseline that this check cannot read — keep the baseline in the " +
        "repository root, named .jscpd.<scan>-baseline.json",
      `\n1 jscpd-baseline issue(s) found. See ${RATCHET_GUIDE}.`,
    ]);
  });

  test("fails loudly when origin/main is missing", async () => {
    const run = stubRun({
      "git merge-base HEAD origin/main": {
        code: 128,
        stderr: "fatal: not a valid revision",
        stdout: "",
      },
    });
    await expect(
      ratchetExit({
        output,
        readBaselines: () => Promise.resolve([]),
        readNamedBaselines: () => Promise.resolve([]),
        run,
      }),
    ).rejects.toThrow(/git fetch origin main/);
  });
});

/** The file names the repository root holds. */
const rootNames = async (): Promise<string[]> => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(projectRoot)) names.push(entry.name);
  return names;
};

describe("baselineFiles", () => {
  test("reads the text of every committed baseline in the root", async () => {
    const files = await baselineFiles();
    expect(files.map(({ path }) => path)).toEqual(
      baselineFileNames(await rootNames()),
    );
    for (const { path, text } of files) {
      expect(text).toBe(await Deno.readTextFile(join(projectRoot, path)));
    }
  });
});

describe("taskBaselines", () => {
  test("names only baselines that the ratchet reads", async () => {
    const named = await taskBaselines();
    expect(named).toContain(".jscpd.baseline.json");
    expect(
      unreadBaselineFindings(
        named,
        (await baselineFiles()).map(({ path }) => path),
      ),
    ).toEqual([]);
  });
});
