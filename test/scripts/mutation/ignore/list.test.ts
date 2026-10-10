import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ignoreListProblems,
  isIgnored,
  listRegistryFiles,
  loadIgnoreList,
  mutantKey,
  registryFilePath,
} from "#scripts/mutation/ignore.ts";
import { tempDir, tempFile } from "#test-utils/files.ts";
import { file, ignoreList, mutant, result } from "./helpers.ts";

describe("mutation ignore list", () => {
  test("keys mutants by path, what they sit inside, and the mutation", () => {
    expect(mutantKey(file, mutant(12))).toBe("src/example.ts::fn12 ??→||");
  });

  test("matches ignored survivors by canonical key", () => {
    const ignore = ignoreList([mutantKey(file, mutant(12))]);

    expect(isIgnored(ignore, file, mutant(12))).toBe(true);
    expect(isIgnored(ignore, file, mutant(13))).toBe(false);
  });

  test("loads canonical entries, skipping comments and blanks", async () => {
    using temp = tempFile({ prefix: "mutation-ignore-" });
    await Deno.writeTextFile(
      temp.path,
      [
        "# known equivalent mutants",
        "",
        "src/example.ts::readSetting ?? → || # nullish and or equivalent here",
      ].join("\n"),
    );

    const loaded = await loadIgnoreList([temp.path]);

    expect(loaded.entries).toEqual([
      {
        key: "src/example.ts::readSetting ??→||",
        sourcePath: "src/example.ts",
      },
    ]);
    expect(loaded.keys.has("src/example.ts::readSetting ??→||")).toBe(true);
  });

  /** A line that neither parses nor reads as a comment is a record that would
   * otherwise stop suppressing its mutant without saying so. */
  test("fails on a line that is neither a comment nor an entry", async () => {
    using temp = tempFile({ prefix: "mutation-ignore-" });
    await Deno.writeTextFile(temp.path, "not a valid entry\n");

    await expect(loadIgnoreList([temp.path])).rejects.toThrow(
      "Malformed equivalent-mutant entry",
    );
  });

  test("loads an entry with an empty 'from' side, for an already-empty string literal mutant", async () => {
    // stringLiteralMutants displays an empty label when the original literal
    // is already "" (its only replacement is "mutated"), so a legitimate
    // ignore-list entry can have nothing between the location and the arrow.
    using temp = tempFile({ prefix: "mutation-ignore-" });
    await Deno.writeTextFile(
      temp.path,
      [`src/example.ts::fn12  → "mutated" # always-empty date sentinel`].join(
        "\n",
      ),
    );

    const loaded = await loadIgnoreList([temp.path]);

    expect(loaded.entries).toEqual([
      { key: 'src/example.ts::fn12 →"mutated"', sourcePath: "src/example.ts" },
    ]);
    expect(isIgnored(loaded, file, mutant(12, "", '"mutated"'))).toBe(true);
  });

  test("merges every registry file in a directory, in name order", async () => {
    using dir = tempDir({ prefix: "mutation-ignore-dir-" });
    await Deno.writeTextFile(
      `${dir.path}/b-late.txt`,
      "src/example.ts::second ?? → ||\n",
    );
    await Deno.writeTextFile(
      `${dir.path}/a-early.txt`,
      "src/example.ts::first ?? → ||\n",
    );
    await Deno.writeTextFile(`${dir.path}/notes.md`, "not a registry file\n");

    const loaded = await loadIgnoreList(await listRegistryFiles(dir.path));

    expect(loaded.entries.map((entry) => entry.key)).toEqual([
      "src/example.ts::first ??→||",
      "src/example.ts::second ??→||",
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
    const stale = "src/example.ts::noSuchThing ??→||";
    const otherFile = {
      key: "src/other.ts::fn1 ??→||",
      sourcePath: "src/other.ts",
    };

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

  /** One file's path can begin with another's, so scoping by prefix would pull
   * a neighbour's entry into this run and report it stale against mutants that
   * were never generated for it. */
  test("leaves alone an entry for a file whose path merely starts with the mutated one", () => {
    const neighbour = {
      key: "src/example.ts:backup::fn1 ??→||",
      sourcePath: "src/example.ts:backup",
    };

    expect(
      ignoreListProblems(
        ignoreList([neighbour]),
        [result("ignored", 1)],
        [file],
      ),
    ).toEqual([]);
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
