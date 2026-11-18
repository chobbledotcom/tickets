import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkedScans,
  countsFindings,
  type NamedScan,
  RATCHET_GUIDE,
  riseFindings,
  unreadScanFindings,
} from "#scripts/check-cpd-counts/counts-ratchet.ts";
import {
  ratchetExit,
  repositoryTasks,
  workingCountsText,
} from "#scripts/check-cpd-counts/ratchet-run.ts";
import { COUNTS_PATH, readCounts } from "#scripts/jscpd/counts.ts";
import { WRAPPER_FLAGS } from "#scripts/jscpd/options.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { capturedCheckOutput } from "#test-utils/check-script.ts";
import {
  type GitStubAnswer,
  gitShow,
  holds,
  lsTree,
  stubRun,
} from "#test-utils/git-stub.ts";

/** A counts file's text. */
const counts = (values: Record<string, number>): string =>
  JSON.stringify(values);

const scanTask = (
  countsFile: string | undefined,
  scan: string | undefined,
): NamedScan => ({ counts: countsFile, scan, task: "cpd" });

const CPD = "deno run -A scripts/cpd.ts";

describe("checkedScans", () => {
  test("reads the counts file and scan name of every scan that checks a count", () => {
    expect(
      checkedScans({
        cpd:
          "deno run -A scripts/check-cpd-counts.ts && " +
          `${CPD} --config cfg/jscpd.json --counts cfg/cpd-counts.json ` +
          "--scan main --fail-on-new-clones && " +
          `${CPD} --config cfg/jscpd.css.json`,
        "cpd:update":
          `${CPD} --config cfg/jscpd.test.json ` +
          "--counts=cfg/cpd-counts.json --scan=test --update",
        test: "deno task test",
      }),
    ).toEqual([
      { counts: COUNTS_PATH, scan: "main", task: "cpd" },
      { counts: COUNTS_PATH, scan: "test", task: "cpd:update" },
    ]);
  });

  test("holds no scan when no task checks a count", () => {
    expect(checkedScans({ css: `${CPD} --config cfg/jscpd.css.json` })).toEqual(
      [],
    );
  });

  test("reads a scan that names the flags the scan reads", () => {
    expect(
      checkedScans({
        cpd:
          `${CPD} --config cfg/jscpd.json ${WRAPPER_FLAGS.counts} ` +
          `${COUNTS_PATH} ${WRAPPER_FLAGS.scan} main ${WRAPPER_FLAGS.check}`,
      }),
    ).toEqual([{ counts: COUNTS_PATH, scan: "main", task: "cpd" }]);
  });

  test("reads no counts file and no scan name when a checked scan names none", () => {
    expect(
      checkedScans({
        "cpd:no-counts": `${CPD} --config cfg/jscpd.json --scan main --update`,
        "cpd:no-scan": `${CPD} --config cfg/jscpd.json --counts ${COUNTS_PATH} --update`,
      }),
    ).toEqual([
      { counts: undefined, scan: "main", task: "cpd:no-counts" },
      { counts: COUNTS_PATH, scan: undefined, task: "cpd:no-scan" },
    ]);
  });
});

describe("unreadScanFindings", () => {
  test("passes when every checked scan names a count the file holds", () => {
    expect(
      unreadScanFindings([scanTask(COUNTS_PATH, "main")], { main: 3 }),
    ).toEqual([]);
  });

  test("names a task that points at another counts file", () => {
    expect(
      unreadScanFindings([scanTask("cfg/other.json", "main")], { main: 3 }),
    ).toEqual([
      "deno.json:cpd [unread-scan]: is a scan that this check cannot read a " +
        "count for — name --counts cfg/cpd-counts.json and --scan <name>",
    ]);
  });

  test("names a task that gives no scan name", () => {
    expect(unreadScanFindings([scanTask(COUNTS_PATH, undefined)], {})).toEqual([
      "deno.json:cpd [unread-scan]: is a scan that this check cannot read a " +
        "count for — name --counts cfg/cpd-counts.json and --scan <name>",
    ]);
  });

  test("names a scan that the counts file does not hold", () => {
    expect(
      unreadScanFindings([scanTask(COUNTS_PATH, "specs")], { main: 3 }),
    ).toEqual([
      "cfg/cpd-counts.json:specs [missing-count]: holds no count for a scan " +
        "that a task checks — run deno task cpd:update to add it",
    ]);
  });
});

describe("riseFindings", () => {
  test("passes a scan that matches the base and one below it", () => {
    expect(riseFindings({ main: 3 }, { main: 3 })).toEqual([]);
    expect(riseFindings({ main: 2 }, { main: 3 })).toEqual([]);
  });

  test("names a count above the base's", () => {
    expect(riseFindings({ main: 4 }, { main: 3 })).toEqual([
      "cfg/cpd-counts.json:main [raised-count]: records 4 place(s), up from " +
        "3 — merge the duplicated code, then lower the count with --update",
    ]);
  });

  test("names a scan the base does not hold", () => {
    expect(riseFindings({ specs: 2 }, {})).toEqual([
      "cfg/cpd-counts.json:specs [raised-count]: records 2 place(s), up from " +
        "0 — merge the duplicated code, then lower the count with --update",
    ]);
  });

  test("reports the scans in name order", () => {
    expect(
      riseFindings({ helpers: 1, main: 1 }, {}).map((line) =>
        line.slice(0, line.indexOf(" ")),
      ),
    ).toEqual(["cfg/cpd-counts.json:helpers", "cfg/cpd-counts.json:main"]);
  });
});

describe("countsFindings", () => {
  test("compares the counts with the merge base's", () => {
    expect(
      countsFindings(counts({ main: 4 }), counts({ main: 3 }), []),
    ).toEqual([
      "cfg/cpd-counts.json:main [raised-count]: records 4 place(s), up from " +
        "3 — merge the duplicated code, then lower the count with --update",
    ]);
  });

  test("passes a merge base that holds no counts file", () => {
    expect(countsFindings(counts({ main: 4 }), undefined, [])).toEqual([]);
  });

  test("holds the scan tasks to the working tree's counts", () => {
    expect(
      countsFindings(counts({}), undefined, [scanTask(COUNTS_PATH, "main")]),
    ).toEqual([
      "cfg/cpd-counts.json:main [missing-count]: holds no count for a scan " +
        "that a task checks — run deno task cpd:update to add it",
    ]);
  });
});

describe("ratchetExit", () => {
  const output = capturedCheckOutput();

  /** The task that checks the main scan against the counts file. */
  const TASKS = {
    cpd:
      `${CPD} --config cfg/jscpd.json --counts ${COUNTS_PATH} ` +
      "--scan main --fail-on-new-clones",
  };

  /** A git stub that holds `baseText` at the counts path, or no counts file. */
  const stubFor = (baseText: string | undefined) => {
    const answers: Record<string, GitStubAnswer> = {
      "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
    };
    if (baseText !== undefined) {
      answers[lsTree("base123", COUNTS_PATH)] = holds(COUNTS_PATH);
      answers[gitShow("base123", COUNTS_PATH)] = { code: 0, stdout: baseText };
    } else {
      answers[lsTree("base123", COUNTS_PATH)] = { code: 0, stdout: "" };
    }
    return stubRun(answers);
  };

  const exitFor = async (
    headText: string,
    baseText: string | undefined,
    tasks: Record<string, string> = TASKS,
  ): Promise<number> => {
    output.lines.length = 0;
    return await ratchetExit({
      output,
      readCountsText: () => Promise.resolve(headText),
      readTasks: () => Promise.resolve(tasks),
      run: stubFor(baseText),
    });
  };

  test("passes a counts file that the base holds at the same counts", async () => {
    expect(await exitFor(counts({ main: 3 }), counts({ main: 3 }))).toBe(0);
    expect(output.lines).toEqual([
      "No cpd count holds more places than the merge base on origin/main.",
    ]);
  });

  test("fails on a count the merge base does not hold", async () => {
    expect(await exitFor(counts({ main: 4 }), counts({ main: 3 }))).toBe(1);
    expect(output.lines).toEqual([
      "cfg/cpd-counts.json:main [raised-count]: records 4 place(s), up from " +
        "3 — merge the duplicated code, then lower the count with --update",
      `\n1 cpd-count issue(s) found. See ${RATCHET_GUIDE}.`,
    ]);
  });

  test("fails on a scan task that names no count the file holds", async () => {
    expect(await exitFor(counts({ test: 5 }), counts({ test: 5 }))).toBe(1);
    expect(output.lines).toEqual([
      "cfg/cpd-counts.json:main [missing-count]: holds no count for a scan " +
        "that a task checks — run deno task cpd:update to add it",
      `\n1 cpd-count issue(s) found. See ${RATCHET_GUIDE}.`,
    ]);
  });

  test("fails loudly when the merge base tree cannot be read", async () => {
    const run = stubRun({
      "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
      [lsTree("base123", COUNTS_PATH)]: {
        code: 128,
        stderr: "fatal: bad object base123",
        stdout: "",
      },
    });
    await expect(
      ratchetExit({
        output,
        readCountsText: () => Promise.resolve(counts({ main: 3 })),
        readTasks: () => Promise.resolve({}),
        run,
      }),
    ).rejects.toThrow(
      "git ls-tree base123 -- cfg/cpd-counts.json failed: fatal: bad object " +
        "base123",
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
        readCountsText: () => Promise.resolve(counts({})),
        readTasks: () => Promise.resolve({}),
        run,
      }),
    ).rejects.toThrow(/git fetch origin main/);
  });
});

describe("the committed counts", () => {
  test("reads the counts file the scans name", async () => {
    expect(await workingCountsText()).toBe(
      await Deno.readTextFile(join(projectRoot, COUNTS_PATH)),
    );
  });

  test("holds a count for every scan that a task checks", async () => {
    const scans = checkedScans(await repositoryTasks());
    const names = new Set(
      scans.flatMap(({ scan }) => (scan === undefined ? [] : [scan])),
    );
    expect([...names].sort()).toEqual([
      "helpers",
      "main",
      "renamed",
      "specs",
      "support",
      "test",
    ]);
    const head = readCounts(COUNTS_PATH, await workingCountsText());
    expect(unreadScanFindings(scans, head)).toEqual([]);
  });
});
