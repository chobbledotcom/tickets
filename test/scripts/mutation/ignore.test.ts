import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Mutant } from "#scripts/mutation/generate.ts";
import {
  type IgnoreList,
  ignoreListProblems,
  isIgnored,
  listRegistryFiles,
  loadIgnoreList,
  mutantKey,
  registryFilePath,
} from "#scripts/mutation/ignore.ts";
import type { MutantResult } from "#scripts/mutation/summary.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { tempDir, tempFile } from "#test-utils/files.ts";

const file = `${projectRoot}/src/example.ts`;

const mutant = (line: number, operator = "??", newOperator = "||"): Mutant => ({
  column: 5,
  end: 1,
  line,
  newOperator,
  operator,
  start: 0,
});

const result = (
  status: MutantResult["status"],
  line: number,
): MutantResult => ({
  detectedBy: null,
  file,
  mutant: mutant(line),
  status,
  timings: [],
});

const ignoreList = (entries: string[]): IgnoreList => ({
  entries,
  keys: new Set(entries),
});

describe("mutation ignore list", () => {
  test("keys mutants by project-relative path and displayed mutation", () => {
    expect(mutantKey(file, mutant(12))).toBe("src/example.ts:12:5 ??→||");
  });

  test("matches ignored survivors by canonical key", () => {
    const ignore = ignoreList([mutantKey(file, mutant(12))]);

    expect(isIgnored(ignore, file, mutant(12))).toBe(true);
    expect(isIgnored(ignore, file, mutant(13))).toBe(false);
  });

  test("loads canonical entries and ignores comments, blanks, and invalid lines", async () => {
    using temp = tempFile({ prefix: "mutation-ignore-" });
    await Deno.writeTextFile(
      temp.path,
      [
        "# known equivalent mutants",
        "",
        "not a valid entry",
        "src/example.ts:12:5 ?? → || # nullish and or equivalent here",
      ].join("\n"),
    );

    const loaded = await loadIgnoreList([temp.path]);

    expect(loaded.entries).toEqual(["src/example.ts:12:5 ??→||"]);
    expect(loaded.keys.has("src/example.ts:12:5 ??→||")).toBe(true);
  });

  test("loads an entry with an empty 'from' side, for an already-empty string literal mutant", async () => {
    // stringLiteralMutants displays an empty label when the original literal
    // is already "" (its only replacement is "mutated"), so a legitimate
    // ignore-list entry can have nothing between the location and the arrow.
    using temp = tempFile({ prefix: "mutation-ignore-" });
    await Deno.writeTextFile(
      temp.path,
      [`src/example.ts:12:5  → "mutated" # always-empty date sentinel`].join(
        "\n",
      ),
    );

    const loaded = await loadIgnoreList([temp.path]);

    expect(loaded.entries).toEqual(['src/example.ts:12:5 →"mutated"']);
    expect(isIgnored(loaded, file, mutant(12, "", '"mutated"'))).toBe(true);
  });

  test("merges every registry file in a directory, in name order", async () => {
    using dir = tempDir({ prefix: "mutation-ignore-dir-" });
    await Deno.writeTextFile(
      `${dir.path}/b-late.txt`,
      "src/example.ts:13:5 ?? → ||\n",
    );
    await Deno.writeTextFile(
      `${dir.path}/a-early.txt`,
      "src/example.ts:12:5 ?? → ||\n",
    );
    await Deno.writeTextFile(`${dir.path}/notes.md`, "not a registry file\n");

    const loaded = await loadIgnoreList(await listRegistryFiles(dir.path));

    expect(loaded.entries).toEqual([
      "src/example.ts:12:5 ??→||",
      "src/example.ts:13:5 ??→||",
    ]);
  });

  test("loads the checked-in registry directory by default", async () => {
    const files = await listRegistryFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const registryFile of files) {
      expect(String(registryFile)).toMatch(/\.txt$/);
    }

    // The default load is exactly the merge of the listed registry files.
    const loaded = await loadIgnoreList();
    expect(loaded.entries.length).toBeGreaterThan(0);
    expect(loaded.entries).toEqual((await loadIgnoreList(files)).entries);
  });

  test("lists no registry files when the directory is absent", async () => {
    expect(await listRegistryFiles("/tmp/missing-mutation-ignore-dir")).toEqual(
      [],
    );
  });

  test("surfaces a registry file that exists but cannot be read", async () => {
    using dir = tempDir({ prefix: "mutation-ignore-unreadable-" });

    // A directory path given as a registry file fails with a non-NotFound
    // error, which must surface rather than reading as an empty registry.
    await expect(loadIgnoreList([dir.path])).rejects.toThrow(/directory/i);
  });

  test("uses an empty ignore list when the file is absent", async () => {
    const loaded = await loadIgnoreList([
      "/tmp/missing-mutation-ignore-list.txt",
    ]);

    expect(loaded.entries).toEqual([]);
    expect(loaded.keys.size).toBe(0);
  });

  test("reports stale, redundant, and duplicate entries for mutated files only", () => {
    const ignored = mutantKey(file, mutant(1));
    const redundant = mutantKey(file, mutant(2));
    const stale = "src/example.ts:99:5 ??→||";
    const otherFile = "src/other.ts:1:5 ??→||";

    expect(
      ignoreListProblems(
        ignoreList([ignored, redundant, stale, ignored, otherFile]),
        [result("ignored", 1), result("killed", 2), result("survived", 3)],
        [file],
      ),
    ).toEqual([
      `redundant (a test kills this mutant, not a survivor): ${redundant}`,
      `stale (no mutant here — did the code move?): ${stale}`,
      `duplicate entry: ${ignored}`,
    ]);
  });

  test("accepts an exhaustive-only entry this run didn't generate, given a wider possible-key set", () => {
    // Regression: a non-exhaustive run (e.g. the precommit gate) never
    // generates an --exhaustive-only mutant, so without possibleKeys an entry
    // for one always looks "stale" even though it's a real, valid mutant.
    const exhaustiveOnly = mutantKey(file, mutant(5));

    expect(
      ignoreListProblems(
        ignoreList([exhaustiveOnly]),
        [result("killed", 2)],
        [file],
        new Set([exhaustiveOnly]),
      ),
    ).toEqual([]);
  });

  test("still reports an entry as stale when it matches no mutant, even under the wider possible-key set", () => {
    const stale = mutantKey(file, mutant(99));

    expect(
      ignoreListProblems(
        ignoreList([stale]),
        [result("killed", 2)],
        [file],
        new Set([mutantKey(file, mutant(5))]),
      ),
    ).toEqual([`stale (no mutant here — did the code move?): ${stale}`]);
  });

  test("still reports an entry as redundant when this run tested and killed it, given the wider possible-key set", () => {
    const redundant = mutantKey(file, mutant(2));

    expect(
      ignoreListProblems(
        ignoreList([redundant]),
        [result("killed", 2)],
        [file],
        new Set([redundant]),
      ),
    ).toEqual([
      `redundant (a test kills this mutant, not a survivor): ${redundant}`,
    ]);
  });

  test("registryFilePath keeps a plain path as it is", () => {
    expect(registryFilePath("scripts/mutation/equivalent-mutants/a.txt")).toBe(
      "scripts/mutation/equivalent-mutants/a.txt",
    );
  });

  test("registryFilePath turns a file URL into its path", () => {
    expect(registryFilePath(new URL("file:///tmp/registry/a.txt"))).toBe(
      "/tmp/registry/a.txt",
    );
  });
});
