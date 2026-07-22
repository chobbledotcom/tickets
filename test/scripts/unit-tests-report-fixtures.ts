import type {
  FileLines,
  ReportOptions,
} from "#scripts/unit-tests-report-lib.ts";

/** Report options for tests, with small explicit exempt lists so the exemption
 *  behaviour is easy to assert without depending on the real defaults. */
export const options: ReportOptions = {
  exemptSourcePrefixes: ["src/locales/"],
  exemptTestPrefixes: ["test/e2e/", "test/setup.ts"],
  srcRoot: "src",
  testRoot: "test",
};

/** A source file paired with its line count. */
export const src = (path: string, lines: number): FileLines => ({
  lines,
  path,
});

/** A test file paired with its line count. */
export const tst = (path: string, lines: number): FileLines => ({
  lines,
  path,
});
