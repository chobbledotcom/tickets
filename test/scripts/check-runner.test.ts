import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { runAliasExportCheck } from "#scripts/check-alias-exports/run.ts";
import { runEmptyCatchCheck } from "#scripts/check-empty-catch/run.ts";
import {
  filesOverLimit,
  runFileLengthCheck,
} from "#scripts/check-file-lengths/run.ts";
import { readCounts } from "#scripts/check-runner.ts";
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
        "\n".repeat(400),
      );
      expect(code).toBe(1);
      expect(errors[0]).toContain("[over-limit]: holds 401 lines");
    });

    test("passes a file over the limit at its recorded count", async () => {
      const { code } = await check(
        (roots, output) =>
          runFileLengthCheck(
            roots,
            { [`${dir.path}/src/big.ts`]: 401 },
            output,
          ),
        "big.ts",
        "\n".repeat(400),
      );
      expect(code).toBe(0);
    });

    test("lists every file over the limit with its current count", async () => {
      Deno.mkdirSync(`${dir.path}/src`);
      Deno.writeTextFileSync(`${dir.path}/src/big.ts`, "\n".repeat(400));
      Deno.writeTextFileSync(`${dir.path}/src/small.ts`, "\n");
      const over = await filesOverLimit([dir.path]);
      expect(over).toEqual({ [`${dir.path}/src/big.ts`]: 401 });
    });
  });
});
