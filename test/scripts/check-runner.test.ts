import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { runAliasExportCheck } from "#scripts/check-alias-exports/run.ts";
import { runEmptyCatchCheck } from "#scripts/check-empty-catch/run.ts";
import {
  filesOverLimit,
  runFileLengthCheck,
} from "#scripts/check-file-lengths/run.ts";
import {
  type Counts,
  compareCounts,
  countsRose,
  ratchetedState,
  readCounts,
  recordedState,
  updateMode,
} from "#scripts/check-runner.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";

describe("reading the counts a check ratchets on", () => {
  let dir: TempPath;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    dir.dispose();
  });

  const writeCounts = (text: string): string => {
    const path = `${dir.path}/counts.json`;
    Deno.writeTextFileSync(path, text);
    return path;
  };

  test("gives back the counts the file holds", async () => {
    const path = writeCounts('{ "a.md": 2, "b.md": 0 }');
    expect(await readCounts(path)).toEqual({ "a.md": 2, "b.md": 0 });
  });

  test("fails loudly for a counts file that is not there", async () => {
    await expect(readCounts(`${dir.path}/gone.json`)).rejects.toThrow();
  });

  test("fails loudly for counts of the wrong shape", async () => {
    const path = writeCounts('{ "a.md": "two" }');
    await expect(readCounts(path)).rejects.toThrow();
  });

  test("fails loudly for a negative or fractional count", async () => {
    const negative = writeCounts('{ "a.md": -1 }');
    await expect(readCounts(negative)).rejects.toThrow();
    const fractional = writeCounts('{ "a.md": 1.5 }');
    await expect(readCounts(fractional)).rejects.toThrow();
  });
});

describe("the per-file check runners", () => {
  let dir: TempPath;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    dir.dispose();
  });

  /** A check that takes the trees and reports its findings: the shape every
   * per-file runner has, whatever else it also reads. */
  type Check = (
    roots: readonly string[],
    output: { log: (l: string) => void; logError: (l: string) => void },
  ) => Promise<number>;

  /** Write one TypeScript file, run a check over the temp folder, and hand
   * back the exit code plus the lines sent to each logger. */
  const check = async (run: Check, name: string, content: string) => {
    Deno.mkdirSync(`${dir.path}/src`);
    Deno.writeTextFileSync(`${dir.path}/src/${name}`, content);
    const out: string[] = [];
    const errors: string[] = [];
    const code = await run([dir.path], {
      log: (line: string) => out.push(line),
      logError: (line: string) => errors.push(line),
    });
    return { code, errors, out };
  };

  describe("alias exports", () => {
    test("fails naming the export that renames an import", async () => {
      const { code, errors, out } = await check(
        runAliasExportCheck,
        "alias.ts",
        'import { byParent } from "#shared/parents.ts";\n' +
          "export const getChildIds = byParent.getIds;\n",
      );
      expect(code).toBe(1);
      expect(out).toEqual([]);
      expect(errors[0]).toBe(
        `${dir.path}/src/alias.ts:2 [alias-export]: "getChildIds" renames ` +
          "the imported byParent.getIds — export byParent.getIds itself, and " +
          "let callers use it",
      );
    });

    test("passes a tree with no alias export", async () => {
      const { code, errors, out } = await check(
        runAliasExportCheck,
        "plain.ts",
        "export const total = 3;\n",
      );
      expect(code).toBe(0);
      expect(errors).toEqual([]);
      expect(out).toContain("Every exported name says what it names.");
    });
  });

  describe("empty catch", () => {
    test("fails naming the catch that says nothing", async () => {
      const { code, errors } = await check(
        runEmptyCatchCheck,
        "empty.ts",
        "try {\n  save();\n} catch (e) {}\n",
      );
      expect(code).toBe(1);
      expect(errors[0]).toContain(`${dir.path}/src/empty.ts:3 [empty-catch]`);
      expect(errors[0]).toContain("no statement and no comment");
    });

    test("passes a tree whose catches explain themselves", async () => {
      const { code, out } = await check(
        runEmptyCatchCheck,
        "caught.ts",
        "try {\n  save();\n} catch (e) {\n  recover(e);\n}\n",
      );
      expect(code).toBe(0);
      expect(out).toContain(
        "Every catch block says what it does with the error.",
      );
    });
  });

  describe("file lengths", () => {
    test("fails a file over the limit with no entry", async () => {
      const { code, errors } = await check(
        (roots, output) => runFileLengthCheck(roots, {}, output),
        "big.ts",
        "\n".repeat(501),
      );
      expect(code).toBe(1);
      expect(errors[0]).toContain("[over-limit]: holds 501 lines");
    });

    test("passes a file between the 400-line aim and the limit", async () => {
      const { code, errors, out } = await check(
        (roots, output) => runFileLengthCheck(roots, {}, output),
        "aim.ts",
        "\n".repeat(450),
      );
      expect(code).toBe(0);
      expect(errors).toEqual([]);
      expect(out).toContain(
        "Every source file sits at or under the limit its list holds it to.",
      );
    });

    test("passes a file over the limit at its recorded count", async () => {
      const { code } = await check(
        (roots, output) =>
          runFileLengthCheck(
            roots,
            { [`${dir.path}/src/big.ts`]: 501 },
            output,
          ),
        "big.ts",
        "\n".repeat(501),
      );
      expect(code).toBe(0);
    });

    test("lists every file over the limit with its current count", async () => {
      Deno.mkdirSync(`${dir.path}/src`);
      Deno.writeTextFileSync(`${dir.path}/src/big.ts`, "\n".repeat(501));
      Deno.writeTextFileSync(`${dir.path}/src/small.ts`, "\n");
      const over = await filesOverLimit([dir.path]);
      expect(over).toEqual({ [`${dir.path}/src/big.ts`]: 501 });
    });

    test("reads authored shell and stylesheet files, not the frozen ones", async () => {
      Deno.mkdirSync(`${dir.path}/ui/static`, { recursive: true });
      const write = (name: string, lines: number) =>
        Deno.writeTextFileSync(`${dir.path}/${name}`, "\n".repeat(lines));
      write("authored.css", 501);
      write("ui/static/style.css", 501);
      write("ui/static/logistics-map.css", 501);
      write("run.sh", 501);
      const over = await filesOverLimit([dir.path]);
      expect(Object.keys(over)).toEqual([
        `${dir.path}/authored.css`,
        `${dir.path}/run.sh`,
      ]);
    });

    test("fails an accepted entry whose file is gone, asking for deletion", async () => {
      Deno.mkdirSync(`${dir.path}/src`);
      Deno.writeTextFileSync(`${dir.path}/src/kept.ts`, "\n");
      const errors: string[] = [];
      const code = await runFileLengthCheck(
        [dir.path],
        { [`${dir.path}/src/gone.ts`]: 500 },
        {
          log: () => {},
          logError: (line: string) => errors.push(line),
        },
      );
      expect(code).toBe(1);
      expect(errors[0]).toContain(`${dir.path}/src/gone.ts [stale-entry]`);
      expect(errors[0]).toContain("delete the entry");
      expect(errors[1]).toContain("1 file-length issue(s) found");
    });
  });
});

describe("the record step of a ratchet", () => {
  let dir: TempPath;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    dir.dispose();
  });

  /** Write JSON in the registry format `writeJsonFile` produces. */
  const counted = (path: string, value: unknown): void => {
    Deno.writeTextFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };

  const recordPath = (): string => `${dir.path}/record.json`;

  test("countsRose answers yes only for a rise, missing keys included", () => {
    expect(countsRose({ "a.md": 2 }, { "a.md": 2 })).toBe(false);
    expect(countsRose({ "a.md": 2 }, { "a.md": 1 })).toBe(false);
    expect(countsRose({ "a.md": 2 }, { "a.md": 3 })).toBe(true);
    expect(countsRose({}, { "new.md": 1 })).toBe(true);
    expect(countsRose({ "a.md": 2 }, {})).toBe(false);
  });

  test("compareCounts reports only the findings past their recorded count", () => {
    const findings = [
      { fix: "f", line: 1, problem: "one", rule: "r" },
      { fix: "f", line: 2, problem: "two", rule: "r" },
      { fix: "f", line: 3, problem: "three", rule: "s" },
    ];
    const input = {
      current: { r: 2, s: 1 },
      file: "a.md",
      findings,
      keyOf: (finding: { rule: string }) => finding.rule,
      recorded: { r: 1 } as Counts,
      updateCommand: "deno task check --update",
      whereOf: (finding: { line: number }) => `a.md:${finding.line}`,
    };

    // The rule was allowed one and seen twice: one excess finding reports.
    // The key that was never recorded starts at zero, so its finding rises.
    // A key whose count held or fell never reports, even when another key
    // rose.
    expect(
      compareCounts({
        ...input,
        current: { r: 2, s: 1, y: 0 },
        findings: [
          ...findings,
          { fix: "f", line: 5, problem: "gone", rule: "x" },
          { fix: "f", line: 7, problem: "held", rule: "y" },
        ],
        recorded: { r: 1, x: 2, y: 0 } as Counts,
      }),
    ).toEqual(["a.md:1 [r]: one — f", "a.md:3 [s]: three — f"]);
    // A held count is quiet.
    expect(compareCounts({ ...input, current: { r: 1, s: 0 } })).toEqual([]);
    // A fallen count asks for the step to be recorded.
    expect(compareCounts({ ...input, current: {} })).toEqual([
      "a.md [improved]: fewer findings than recorded (none) — run `deno task check --update` to record the step",
    ]);
    // A fall with keys still held names what the records keep.
    expect(
      compareCounts({
        ...input,
        current: { r: 1, s: 1 },
        recorded: { r: 1, s: 2 } as Counts,
      }),
    ).toEqual([
      "a.md [improved]: fewer findings than recorded (r: 1, s: 1) — run `deno task check --update` to record the step",
    ]);
  });

  test("updateMode reads the recording flag off the command line", () => {
    expect(updateMode([])).toEqual({ update: false });
    expect(updateMode(["--update"])).toEqual({ update: true });
  });

  test("updateMode fails loudly for the removed --seed flag", () => {
    expect(() => updateMode(["--seed"])).toThrow(
      "The --seed flag is gone. A registry only falls.",
    );
  });

  /** Record `count` of `a.md` on disk, then run one recording pass, and
   * hand back what the check must now compare against plus what landed on
   * disk. */
  const recording = async (
    flags: readonly string[],
    fresh: Record<string, number>,
  ): Promise<{ after: unknown; onDisk: unknown }> => {
    const path = recordPath();
    counted(path, { "a.md": 2 });
    const after = await recordedState(
      path,
      updateMode(flags),
      { "a.md": 2 },
      () => Promise.resolve(fresh),
      countsRose,
    );
    return { after, onDisk: JSON.parse(Deno.readTextFileSync(path)) };
  };

  test("recordedState changes nothing without a recording flag", async () => {
    const path = recordPath();
    counted(path, { old: 1 });
    expect(
      await recordedState(
        path,
        updateMode([]),
        { old: 1 },
        () => Promise.resolve({ fresh: 2 }),
        countsRose,
      ),
    ).toEqual({ old: 1 });
    expect(JSON.parse(Deno.readTextFileSync(path))).toEqual({ old: 1 });
  });

  test("recordedState records the fresh state when nothing rose, and the check runs on it", async () => {
    const { after, onDisk } = await recording(["--update"], { "a.md": 1 });
    expect(after).toEqual({ "a.md": 1 });
    expect(onDisk).toEqual({ "a.md": 1 });
  });

  test("recordedState refuses a rise, keeping what the check must compare against", async () => {
    const { after, onDisk } = await recording(["--update"], { "a.md": 5 });
    expect(after).toEqual({ "a.md": 2 });
    expect(onDisk).toEqual({ "a.md": 2 });
  });

  test("a removed registry can no longer be recorded anew", () => {
    const path = recordPath();
    counted(path, { "a.md": 2 });
    expect(() => updateMode(["--seed"])).toThrow(
      "The --seed flag is gone. A registry only falls.",
    );
    expect(JSON.parse(Deno.readTextFileSync(path))).toEqual({ "a.md": 2 });
  });

  test("ratchetedState wires the read, the mode, and the rose together", async () => {
    // The registry lives beside the calling module, at `relative`.
    const moduleUrl = `file://${dir.path}/entry.ts`;
    const path = `${dir.path}/baseline.json`;
    counted(path, { "a.md": { ";": 2 } });

    expect(
      await ratchetedState(moduleUrl, "./baseline.json", [], () =>
        Promise.resolve({ "a.md": { ";": 2 } }),
      ),
    ).toEqual({ "a.md": { ";": 2 } });
    // A fall records; a rise refuses and keeps the recorded state. A file
    // the records never held is a rise too.
    expect(
      await ratchetedState(moduleUrl, "./baseline.json", ["--update"], () =>
        Promise.resolve({ "a.md": { ";": 1 } }),
      ),
    ).toEqual({ "a.md": { ";": 1 } });
    expect(
      await ratchetedState(moduleUrl, "./baseline.json", ["--update"], () =>
        Promise.resolve({ "a.md": { ";": 5 } }),
      ),
    ).toEqual({ "a.md": { ";": 1 } });
    expect(
      await ratchetedState(moduleUrl, "./baseline.json", ["--update"], () =>
        Promise.resolve({ "a.md": { ";": 1 }, "new.md": { ";": 2 } }),
      ),
    ).toEqual({ "a.md": { ";": 1 } });
    expect(JSON.parse(Deno.readTextFileSync(path))).toEqual({
      "a.md": { ";": 1 },
    });
  });

  test("ratchetedState fails loudly when the registry is missing", async () => {
    const moduleUrl = `file://${dir.path}/entry.ts`;
    await expect(
      ratchetedState(moduleUrl, "./absent.json", [], () =>
        Promise.resolve({ "a.md": { ";": 1 } }),
      ),
    ).rejects.toThrow("Cannot read the JSON at");
  });

  test("ratchetedState fails loudly for a malformed registry count", async () => {
    const moduleUrl = `file://${dir.path}/entry.ts`;
    const path = `${dir.path}/baseline.json`;
    counted(path, { "a.md": { ";": -1 } });
    await expect(
      ratchetedState(moduleUrl, "./baseline.json", [], () =>
        Promise.resolve({ "a.md": { ";": 1 } }),
      ),
    ).rejects.toThrow();
  });

  test("a registry beside a module in a spaced directory is found", async () => {
    const spaced = `${dir.path}/check out`;
    Deno.mkdirSync(spaced);
    const moduleUrl = `file://${spaced}/entry.ts`;
    const path = `${spaced}/baseline.json`;
    counted(path, { "a.md": { ";": 1 } });
    expect(
      await ratchetedState(moduleUrl, "./baseline.json", [], () =>
        Promise.resolve({ "a.md": { ";": 1 } }),
      ),
    ).toEqual({ "a.md": { ";": 1 } });
  });
});
