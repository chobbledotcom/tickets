import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  baselineFileNames,
  baselinePathsNamed,
  basePathFor,
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
import { directoryNames } from "#test-utils/files.ts";
import {
  type GitStubAnswer,
  gitShow,
  holds,
  lsPaths,
  lsTree,
  stubRun,
} from "#test-utils/git-stub.ts";

const BASELINE = "cfg/.jscpd.baseline.json";

/** A baseline file's text, in the shape jscpd writes. */
const baseline = (counts: Record<string, number>): string =>
  JSON.stringify({ fingerprints: counts, version: 1 });

describe("baselineFileNames", () => {
  test("keeps the baseline files and sorts them", () => {
    expect(
      baselineFileNames([
        ".jscpd.test-baseline.json",
        "jscpd.json",
        "deno.json",
        ".jscpd.renamed-baseline.json",
        ".jscpd.baseline.json",
        "jscpd.test.json",
      ]),
    ).toEqual([
      ".jscpd.baseline.json",
      ".jscpd.renamed-baseline.json",
      ".jscpd.test-baseline.json",
    ]);
  });

  test("keeps nothing when the directory holds no baseline", () => {
    expect(baselineFileNames(["deno.json", "jscpd.specs.json"])).toEqual([]);
  });
});

describe("basePathFor", () => {
  const base = [
    ".jscpd.baseline.json",
    "cfg/.jscpd.test-baseline.json",
    "deno.json",
  ];

  test("finds the base copy by file name, wherever the tree holds it", () => {
    expect(
      [
        BASELINE,
        "cfg/.jscpd.test-baseline.json",
        "cfg/.jscpd.specs-baseline.json",
      ].map((path) => basePathFor(base, path)),
    ).toEqual([
      ".jscpd.baseline.json",
      "cfg/.jscpd.test-baseline.json",
      undefined,
    ]);
  });

  test("refuses a base that holds two files of the name", () => {
    expect(() =>
      basePathFor([BASELINE, ".jscpd.baseline.json"], BASELINE),
    ).toThrow(
      "The merge base holds more than one file named .jscpd.baseline.json: " +
        "cfg/.jscpd.baseline.json, .jscpd.baseline.json.",
    );
  });
});

describe("baselinePathsNamed", () => {
  test("reads the baseline of every scan task, once each, in path order", () => {
    expect(
      baselinePathsNamed({
        "check:copy": "deno run -A scripts/check-copy.ts",
        cpd:
          "deno run -A scripts/cpd.ts --config cfg/jscpd.json " +
          "--baseline cfg/.jscpd.test-baseline.json && deno run -A " +
          "scripts/cpd.ts --config cfg/jscpd.test.json " +
          "--baseline cfg/.jscpd.test-baseline.json",
        "cpd:helpers":
          "deno run -A scripts/cpd.ts --config cfg/jscpd.helpers.json " +
          "--baseline=cfg/.jscpd.helpers-baseline.json",
        "cpd:renamed":
          "deno run -A scripts/cpd.ts --config cfg/jscpd.renamed.json " +
          "--baseline cfg/.jscpd.baseline.json",
      }),
    ).toEqual([
      "cfg/.jscpd.baseline.json",
      "cfg/.jscpd.helpers-baseline.json",
      "cfg/.jscpd.test-baseline.json",
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
        [BASELINE],
        [BASELINE, "cfg/.jscpd.test-baseline.json"],
      ),
    ).toEqual([]);
  });

  test("names a scan baseline outside the cfg pattern, in path order", () => {
    expect(
      unreadBaselineFindings(
        ["cfg/.jscpd.zzz-baseline.json", "scripts/jscpd/aaa-baseline.json"],
        [BASELINE],
      ),
    ).toEqual([
      "cfg/.jscpd.zzz-baseline.json [unread-baseline]: is a scan baseline " +
        "that this check cannot read — keep the baseline in cfg/, named " +
        ".jscpd.<scan>-baseline.json",
      "scripts/jscpd/aaa-baseline.json [unread-baseline]: is a scan baseline " +
        "that this check cannot read — keep the baseline in cfg/, named " +
        ".jscpd.<scan>-baseline.json",
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
  test("passes when every clone count matches the base", () => {
    expect(
      riseFindings(BASELINE, baseline({ aaa: 1 }), baseline({ aaa: 1 }), 0),
    ).toEqual([]);
  });

  test("passes a clone the branch removed and one it lowered", () => {
    expect(
      riseFindings(
        BASELINE,
        baseline({ aaa: 1 }),
        baseline({ aaa: 2, bbb: 1 }),
        0,
      ),
    ).toEqual([]);
  });

  test("names a clone the base does not hold", () => {
    expect(
      riseFindings(BASELINE, baseline({ aaa: 1 }), baseline({}), 0),
    ).toEqual([
      `${BASELINE}:aaa [added-clone]: holds 1 clone(s) that the merge base ` +
        "does not hold — merge the duplicated code, then lower the baseline " +
        "with --update",
    ]);
  });

  test("names a clone count above the base's", () => {
    expect(
      riseFindings(BASELINE, baseline({ aaa: 3 }), baseline({ aaa: 2 }), 0),
    ).toEqual([
      `${BASELINE}:aaa [raised-clone]: holds 3 clone(s), up from 2 — merge the ` +
        "duplicated code, then lower the baseline with --update",
    ]);
  });

  test("reports raised clones in fingerprint order", () => {
    expect(
      riseFindings(BASELINE, baseline({ aaa: 1, zzz: 1 }), baseline({}), 0).map(
        (line) => line.slice(0, line.indexOf(" ")),
      ),
    ).toEqual([`${BASELINE}:aaa`, `${BASELINE}:zzz`]);
  });

  test("fails a new baseline that accepts clones", () => {
    expect(
      riseFindings(BASELINE, baseline({ aaa: 1, bbb: 1 }), undefined, 0),
    ).toEqual([
      `${BASELINE} [added-baseline]: is a new baseline that accepts 2 ` +
        "clone(s) — merge the duplicated code before you add the scan",
    ]);
  });

  test("passes a new baseline that accepts no clone", () => {
    expect(riseFindings(BASELINE, baseline({}), undefined, 0)).toEqual([]);
  });
});

describe("ratchetExit", () => {
  const output = capturedCheckOutput();

  /** A git stub that holds `base` at the merge base: the text at each path,
   * keyed by the path the base keeps. */
  const stubFor = (base: Record<string, string>) => {
    const answers: Record<string, GitStubAnswer> = {
      "git diff --name-only base123": { code: 0, stdout: "" },
      "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
      [lsPaths("base123")]: {
        code: 0,
        stdout: Object.keys(base)
          .map((path) => `${path}\n`)
          .join(""),
      },
    };
    for (const [path, text] of Object.entries(base)) {
      answers[lsTree("base123", path)] = holds(path);
      answers[gitShow("base123", path)] = { code: 0, stdout: text };
    }
    return stubRun(answers);
  };

  const exitFor = async (
    files: BaselineFile[],
    base: Record<string, string>,
    named: string[] = files.map(({ path }) => path),
  ): Promise<number> => {
    output.lines.length = 0;
    return await ratchetExit({
      output,
      readBaselines: () => Promise.resolve(files),
      readNamedBaselines: () => Promise.resolve(named),
      run: stubFor(base),
      scanNewClones: () => Promise.resolve([]),
    });
  };

  test("passes a baseline the base holds, at its own path or its old one", async () => {
    const files: BaselineFile[] = [
      { path: BASELINE, text: baseline({ aaa: 1 }) },
    ];
    expect(await exitFor(files, { [BASELINE]: baseline({ aaa: 1 }) })).toBe(0);
    expect(
      await exitFor(files, { ".jscpd.baseline.json": baseline({ aaa: 1 }) }),
    ).toBe(0);
    expect(output.lines).toEqual([
      "No jscpd baseline holds a clone above the merge base on origin/main.",
    ]);
  });

  test("passes when the tree holds no baseline", async () => {
    expect(await exitFor([], {})).toBe(0);
  });

  test("fails on a clone the merge base does not hold", async () => {
    expect(
      await exitFor(
        [
          { path: BASELINE, text: baseline({ aaa: 1 }) },
          {
            path: "cfg/.jscpd.renamed-baseline.json",
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
      "cfg/.jscpd.renamed-baseline.json:bbb [added-clone]: holds 1 clone(s) " +
        "that the merge base does not hold — merge the duplicated code, then " +
        "lower the baseline with --update",
      `\n1 jscpd-baseline issue(s) found. See ${RATCHET_GUIDE}.`,
    ]);
  });

  test("fails on a baseline the merge base does not hold", async () => {
    expect(
      await exitFor([{ path: BASELINE, text: baseline({ aaa: 1 }) }], {}),
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
        "baseline that this check cannot read — keep the baseline in cfg/, " +
        "named .jscpd.<scan>-baseline.json",
      `\n1 jscpd-baseline issue(s) found. See ${RATCHET_GUIDE}.`,
    ]);
  });

  test("fails loudly when the merge base tree cannot be read", async () => {
    const run = stubRun({
      "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
      [lsPaths("base123")]: {
        code: 128,
        stderr: "fatal: bad object base123",
        stdout: "",
      },
    });
    await expect(
      ratchetExit({
        output,
        readBaselines: () =>
          Promise.resolve([{ path: BASELINE, text: baseline({}) }]),
        readNamedBaselines: () => Promise.resolve([BASELINE]),
        run,
        scanNewClones: () => Promise.resolve([]),
      }),
    ).rejects.toThrow(
      "git ls-tree -r --name-only base123 failed: fatal: bad object base123",
    );
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
        scanNewClones: () => Promise.resolve([]),
      }),
    ).rejects.toThrow(/git fetch origin main/);
  });
});

describe("baselineFiles", () => {
  test("reads the text of every committed baseline in cfg", async () => {
    const files = await baselineFiles();
    expect(files.map(({ path }) => path)).toEqual(
      baselineFileNames(await directoryNames(join(projectRoot, "cfg"))).map(
        (name) => `cfg/${name}`,
      ),
    );
    for (const { path, text } of files) {
      expect(text).toBe(await Deno.readTextFile(join(projectRoot, path)));
    }
  });
});

describe("taskBaselines", () => {
  test("names only baselines that the ratchet reads", async () => {
    const named = await taskBaselines();
    expect(named).toContain("cfg/.jscpd.baseline.json");
    expect(
      unreadBaselineFindings(
        named,
        (await baselineFiles()).map(({ path }) => path),
      ),
    ).toEqual([]);
  });
});
