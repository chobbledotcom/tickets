import { dirname, join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  baseScanner,
  type NewCloneScanner,
} from "#scripts/check-jscpd-baselines/base-scan.ts";
import {
  addedCloneCount,
  RATCHET_GUIDE,
  riseFindings,
} from "#scripts/check-jscpd-baselines/baseline-ratchet.ts";
import {
  ratchetExit,
  repositoryTasks,
} from "#scripts/check-jscpd-baselines/ratchet-run.ts";
import {
  type NewClone,
  newClones,
  rePairCount,
  scanConfigFor,
} from "#scripts/check-jscpd-baselines/re-pairs.ts";
import type { RunCommand } from "#scripts/precommit/git.ts";
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
const SETTINGS = "src/features/admin/settings.ts";
const ATTENDEES = "src/features/admin/attendees.ts";

/** A baseline file's text, in the shape jscpd writes. */
const baseline = (counts: Record<string, number>): string =>
  JSON.stringify({ fingerprints: counts, version: 1 });

/** One clone of a jscpd report, between two files under `root`. */
const reported = (
  root: string,
  first: string,
  second: string,
  isNew: boolean,
) => ({
  firstFile: { name: join(root, first) },
  isNew,
  secondFile: { name: join(root, second) },
});

const ADDED_LINE =
  `${BASELINE}:new [added-clone]: holds 1 clone(s) that the merge base ` +
  "does not hold — merge the duplicated code, then lower the baseline " +
  "with --update";

describe("newClones", () => {
  test("keeps the clones the baseline does not hold, by path from the root", () => {
    expect(
      newClones(
        {
          duplicates: [
            reported("/repo", SETTINGS, SETTINGS, true),
            reported("/repo", ATTENDEES, SETTINGS, false),
            reported("/repo", ATTENDEES, SETTINGS, true),
          ],
        },
        "/repo",
      ),
    ).toEqual([
      { first: SETTINGS, second: SETTINGS },
      { first: ATTENDEES, second: SETTINGS },
    ]);
  });

  test("refuses a report that does not say which clones are new", () => {
    expect(() =>
      newClones(
        { duplicates: [{ firstFile: { name: "/repo/a.ts" } }] },
        "/repo",
      ),
    ).toThrow();
  });
});

describe("rePairCount", () => {
  const clones: NewClone[] = [
    { first: SETTINGS, second: SETTINGS },
    { first: ATTENDEES, second: SETTINGS },
    { first: SETTINGS, second: ATTENDEES },
  ];

  test("counts a clone only when the branch changed neither file", () => {
    expect(rePairCount(clones, (path) => path === SETTINGS)).toBe(1);
    expect(rePairCount(clones, () => true)).toBe(3);
    expect(rePairCount(clones, () => false)).toBe(0);
  });
});

describe("scanConfigFor", () => {
  const tasks = {
    cpd:
      "deno run -A scripts/cpd.ts --config cfg/jscpd.json --baseline " +
      "cfg/.jscpd.baseline.json --fail-on-new-clones && deno run -A " +
      "scripts/cpd.ts --config=cfg/jscpd.test.json " +
      "--baseline=cfg/.jscpd.test-baseline.json",
    other:
      "deno run tool.ts --config cfg/x.json --baseline cfg/x-baseline.json",
  };

  test("finds the config of the scan that names the baseline", () => {
    expect(scanConfigFor(tasks, "cfg/.jscpd.baseline.json")).toBe(
      "cfg/jscpd.json",
    );
    expect(scanConfigFor(tasks, "cfg/.jscpd.test-baseline.json")).toBe(
      "cfg/jscpd.test.json",
    );
  });

  test("refuses a baseline that no scan task names", () => {
    expect(() => scanConfigFor(tasks, "cfg/x-baseline.json")).toThrow(
      "No cpd task scans with the baseline cfg/x-baseline.json.",
    );
  });
});

describe("addedCloneCount", () => {
  test("adds the counts under fingerprints the base does not hold", () => {
    expect(
      addedCloneCount(
        BASELINE,
        baseline({ kept: 3, new: 2, other: 1 }),
        baseline({ gone: 1, kept: 1 }),
      ),
    ).toBe(3);
    expect(
      addedCloneCount(BASELINE, baseline({ kept: 1 }), baseline({ kept: 1 })),
    ).toBe(0);
  });
});

describe("riseFindings with re-pairs", () => {
  const RAISED =
    `${BASELINE}:kept [raised-clone]: holds 2 clone(s), up from 1 — merge ` +
    "the duplicated code, then lower the baseline with --update";
  const ADDED_TWICE = ADDED_LINE.replace(
    "holds 1 clone(s)",
    "holds 2 clone(s)",
  );

  for (const [name, head, rePairs, expected] of [
    [
      "passes added clones when the scan finds as many re-pairs",
      { kept: 1, new: 1, other: 1 },
      2,
      [],
    ],
    [
      "names every added clone when the scan finds fewer re-pairs",
      { kept: 1, new: 2 },
      1,
      [ADDED_TWICE],
    ],
    [
      "still names a raised count when the added clones pass",
      { kept: 2, new: 1 },
      1,
      [RAISED],
    ],
  ] as const) {
    test(name, () => {
      expect(
        riseFindings(BASELINE, baseline(head), baseline({ kept: 1 }), rePairs),
      ).toEqual([...expected]);
    });
  }
});

describe("ratchetExit with re-pairs", () => {
  const output = capturedCheckOutput();
  const scanned: string[][] = [];

  /** Run the ratchet over one baseline that holds `head`. The merge base
   * holds the clone `kept` and the files `basePaths`. `diff` answers the
   * read of the files that the branch changed. */
  const runRatchet = ({
    basePaths = [SETTINGS, ATTENDEES],
    clones = [],
    diff = { code: 0, stdout: "" },
    head = { kept: 1, new: 1 },
  }: {
    basePaths?: string[];
    clones?: NewClone[];
    diff?: GitStubAnswer;
    head?: Record<string, number>;
  }): Promise<number> => {
    output.lines.length = 0;
    scanned.length = 0;
    return ratchetExit({
      output,
      readBaselines: () =>
        Promise.resolve([{ path: BASELINE, text: baseline(head) }]),
      readNamedBaselines: () => Promise.resolve([BASELINE]),
      run: stubRun({
        "git diff --name-only base123": diff,
        "git merge-base HEAD origin/main": { code: 0, stdout: "base123" },
        [lsPaths("base123")]: {
          code: 0,
          stdout: [BASELINE, ...basePaths].map((path) => `${path}\n`).join(""),
        },
        [lsTree("base123", BASELINE)]: holds(BASELINE),
        [gitShow("base123", BASELINE)]: {
          code: 0,
          stdout: baseline({ kept: 1 }),
        },
      }),
      scanNewClones: (path, base) => {
        scanned.push([path, base]);
        return Promise.resolve(clones);
      },
    });
  };

  const ONE_SCAN = [[BASELINE, baseline({ kept: 1 })]];
  const FAILED = [
    ADDED_LINE,
    `\n1 jscpd-baseline issue(s) found. See ${RATCHET_GUIDE}.`,
  ];

  test("passes an added clone between files the branch did not change", async () => {
    const code = await runRatchet({
      clones: [{ first: SETTINGS, second: SETTINGS }],
      diff: { code: 0, stdout: `${ATTENDEES}\n` },
    });
    expect(code).toBe(0);
    expect(scanned).toEqual(ONE_SCAN);
    expect(output.lines).toEqual([
      "No jscpd baseline holds a clone above the merge base on origin/main.",
    ]);
  });

  test("fails an added clone in a file the branch changed", async () => {
    const code = await runRatchet({
      clones: [{ first: ATTENDEES, second: SETTINGS }],
      diff: { code: 0, stdout: `${ATTENDEES}\n` },
    });
    expect(code).toBe(1);
    expect(output.lines).toEqual(FAILED);
  });

  test("fails an added clone in a file the merge base does not hold", async () => {
    const code = await runRatchet({
      basePaths: [SETTINGS],
      clones: [{ first: SETTINGS, second: ATTENDEES }],
    });
    expect(code).toBe(1);
    expect(output.lines).toEqual(FAILED);
  });

  test("fails an added clone when the scan finds no new clone", async () => {
    expect(await runRatchet({})).toBe(1);
    expect(scanned).toEqual(ONE_SCAN);
    expect(output.lines).toEqual(FAILED);
  });

  test("fails loudly when the changed files cannot be read", async () => {
    await expect(
      runRatchet({
        diff: { code: 128, stderr: "fatal: bad revision", stdout: "" },
      }),
    ).rejects.toThrow(
      "git diff --name-only base123 failed: fatal: bad revision",
    );
  });

  test("runs no scan when the baseline adds no clone", async () => {
    expect(await runRatchet({ head: { kept: 1 } })).toBe(0);
    expect(scanned).toEqual([]);
  });
});
describe("baseScanner", () => {
  const tasks = {
    cpd: "deno run -A scripts/cpd.ts --config cfg/jscpd.json --baseline cfg/.jscpd.baseline.json",
  };

  type Call = { cmd: string[]; cwd: string | undefined; dir: string };

  /** Run `body` with a scanner over a fake jscpd in a fresh directory.
   * `answer` receives the scan directory and says how the command ends. */
  const withScanner = async (
    answer: (dir: string) => Promise<{ stderr: string; success: boolean }>,
    body: (
      scan: NewCloneScanner,
      calls: Call[],
      binary: string,
    ) => Promise<void>,
  ): Promise<void> => {
    const binDir = await Deno.makeTempDir();
    const binary = join(binDir, "jscpd");
    const calls: Call[] = [];
    const run: RunCommand = async (cmd, options) => {
      const dir = cmd[cmd.indexOf("--output") + 1]!;
      calls.push({ cmd, cwd: options?.cwd, dir });
      const { stderr, success } = await answer(dir);
      return { code: success ? 0 : 1, stderr, stdout: "", success };
    };
    const scan = baseScanner({
      jscpd: () => Promise.resolve(binary),
      readTasks: () => Promise.resolve(tasks),
      run,
    });
    try {
      await body(scan, calls, binary);
      // The scan removes its own directory, so the fake binary's stays empty.
      expect(await directoryNames(binDir)).toEqual([]);
    } finally {
      await Deno.remove(binDir, { recursive: true });
    }
  };

  test("scans with the base's baseline and returns the new clones", async () => {
    let baselineSeen = "";
    const answer = async (dir: string) => {
      baselineSeen = await Deno.readTextFile(join(dir, "baseline.json"));
      await Deno.writeTextFile(
        join(dir, "jscpd-report.json"),
        JSON.stringify({
          duplicates: [reported(projectRoot, SETTINGS, SETTINGS, true)],
        }),
      );
      return { stderr: "", success: true };
    };
    await withScanner(answer, async (scan, calls, binary) => {
      expect(await scan(BASELINE, baseline({ kept: 1 }))).toEqual([
        { first: SETTINGS, second: SETTINGS },
      ]);
      expect(baselineSeen).toBe(baseline({ kept: 1 }));
      expect(calls).toHaveLength(1);
      const { cmd, cwd, dir } = calls[0]!;
      expect(dirname(dir)).toBe(dirname(binary));
      expect(cmd).toEqual([
        binary,
        "--config",
        "cfg/jscpd.json",
        "--baseline",
        join(dir, "baseline.json"),
        "--reporters",
        "json",
        "--output",
        dir,
      ]);
      expect(cwd).toBe(projectRoot);
    });
  });

  test("fails loudly when the scan fails, and removes its directory", async () => {
    const answer = () =>
      Promise.resolve({ stderr: "bad config\n", success: false });
    await withScanner(answer, async (scan) => {
      await expect(scan(BASELINE, baseline({}))).rejects.toThrow(
        "The jscpd scan with cfg/jscpd.json failed: bad config",
      );
    });
  });
});

describe("repositoryTasks", () => {
  test("reads the scan tasks, each with a config for its baseline", async () => {
    const tasks = await repositoryTasks();
    expect(scanConfigFor(tasks, BASELINE)).toBe("cfg/jscpd.json");
    expect(scanConfigFor(tasks, "cfg/.jscpd.helpers-baseline.json")).toBe(
      "cfg/jscpd.helpers.json",
    );
  });
});
