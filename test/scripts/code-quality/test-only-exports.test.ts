import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { findTestOnlyExportViolations } from "#test/scripts/code-quality/detectors.ts";

const mapOf = (entries: [string, string][]): Map<string, string> =>
  new Map(entries);

describe("findTestOnlyExportViolations", () => {
  const src = (content: string): Map<string, string> =>
    mapOf([["a.ts", content]]);

  test("flags an export used only by tests", () => {
    expect(
      findTestOnlyExportViolations(
        "a.ts",
        "shared/a.ts",
        src("export const helper = 1;"),
        mapOf([]),
        mapOf([["x.test.ts", 'import { helper } from "../a.ts";']]),
        [],
      ),
    ).toEqual(['shared/a.ts: "helper" is exported but only used in tests']);
  });

  test("does not flag an export also used in production", () => {
    expect(
      findTestOnlyExportViolations(
        "a.ts",
        "shared/a.ts",
        mapOf([
          ["a.ts", "export const helper = 1;"],
          ["b.ts", 'import { helper } from "./a.ts";\nhelper();'],
        ]),
        mapOf([]),
        mapOf([["x.test.ts", 'import { helper } from "../a.ts";']]),
        [],
      ),
    ).toEqual([]);
  });

  test("does not flag an export used nowhere", () => {
    expect(
      findTestOnlyExportViolations(
        "a.ts",
        "shared/a.ts",
        src("export const helper = 1;"),
        mapOf([]),
        mapOf([["x.test.ts", "const y = 1;"]]),
        [],
      ),
    ).toEqual([]);
  });

  test("respects the allowed-test-hooks list", () => {
    expect(
      findTestOnlyExportViolations(
        "a.ts",
        "shared/a.ts",
        src("export const setFooForTest = 1;"),
        mapOf([]),
        mapOf([["x.test.ts", 'import { setFooForTest } from "../a.ts";']]),
        ["shared/a.ts:setFooForTest"],
      ),
    ).toEqual([]);
  });

  test("returns nothing for a re-export aggregation module", () => {
    expect(
      findTestOnlyExportViolations(
        "a.ts",
        "shared/a.ts",
        src('export { x } from "./x.ts";\nexport { z } from "./z.ts";'),
        mapOf([]),
        mapOf([["x.test.ts", 'import { x } from "../a.ts";']]),
        [],
      ),
    ).toEqual([]);
  });
});
