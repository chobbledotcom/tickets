/**
 * One walk of the test tree, shared by everything that asks "what does this
 * test exercise?".
 *
 * `test-subjects.ts` holds the pure logic; this is its filesystem shell. It
 * reads the import map, walks the test tree once, and works out each test's
 * subjects, handing back the cached reader so a caller that also needs a file's
 * text (the coverage report counts lines) never reads it twice.
 *
 * The unit-test coverage report is what calls this. The mutation gate does not
 * — it selects a source's tests by the mirror path alone (see
 * `scripts/mutation/test-map.ts`).
 */

import {
  cachingReader,
  collectTestSubjects,
  type ImportMap,
  type ReadText,
  type TestSubjects,
} from "./test-subjects.ts";
import { walkFiles } from "./walk-files.ts";

/** The result of one scan: every test-tree file, what each selected test
 * exercises, and the reader that produced it. */
export interface TestTreeScan {
  /** True when the test drives the app through a helper it reaches. */
  loadsAppOf: (testFile: string) => boolean;
  readText: ReadText;
  /** The `src/` files a test exercises; empty for a path that wasn't selected. */
  subjectsOf: (testFile: string) => readonly string[];
  testTreeFiles: ReadonlySet<string>;
}

export interface ScanOptions {
  /** The deno config holding the `#` alias map. */
  configPath?: string;
  /** Which walked paths are tests worth resolving subjects for. */
  isTest: (path: string) => boolean;
  testRoot?: string;
}

/** Walk the test tree and resolve every selected test's subjects. */
export const scanTestTree = async ({
  configPath = "deno.json",
  isTest,
  testRoot = "test",
}: ScanOptions): Promise<TestTreeScan> => {
  const importMap: ImportMap = JSON.parse(
    await Deno.readTextFile(configPath),
  ).imports;
  const readText = cachingReader((path: string) => Deno.readTextFile(path));
  const testTreeFiles = new Set<string>();
  for await (const path of walkFiles(testRoot)) testTreeFiles.add(path);
  const walked = new Map<string, TestSubjects>();
  for (const path of testTreeFiles) {
    if (!isTest(path)) continue;
    walked.set(
      path,
      await collectTestSubjects(path, readText, importMap, testTreeFiles),
    );
  }
  return {
    loadsAppOf: (testFile) => walked.get(testFile)?.loadsApp ?? false,
    readText,
    subjectsOf: (testFile) => walked.get(testFile)?.subjects ?? [],
    testTreeFiles,
  };
};
