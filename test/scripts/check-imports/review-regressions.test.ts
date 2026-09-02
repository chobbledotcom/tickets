import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { topLevelImports } from "#scripts/check-imports/rules.ts";

const namedImport = {
  line: 2,
  namesOnly: true,
  reExport: false,
  specifier: "#types",
  typeOnly: false,
};

describe("topLevelImports review regressions", () => {
  test("reads an import after an apostrophe in JSX text", () => {
    const source = [
      "const view = <p>It's ready</p>;",
      'import { value } from "#types";',
    ].join("\n");

    expect(topLevelImports("sample.tsx", source)).toEqual([namedImport]);
  });

  test("reads a pattern after a statement block before an import", () => {
    const source = [
      "if (ready) {} /[/*]/.test(value);",
      'import { value } from "#types";',
    ].join("\n");

    expect(topLevelImports("sample.ts", source)).toEqual([namedImport]);
  });

  test("reads a side-effect import after a semicolonless local export", () => {
    const source = ["export { value }", 'import "#side-effects";'].join("\n");

    expect(topLevelImports("sample.ts", source)).toEqual([
      {
        line: 2,
        namesOnly: false,
        reExport: false,
        specifier: "#side-effects",
        typeOnly: false,
      },
    ]);
  });

  test("keeps a semicolonless re-export as one statement", () => {
    const source = ["export { value }", 'from "#types"'].join("\n");

    expect(topLevelImports("sample.ts", source)).toEqual([
      {
        line: 1,
        namesOnly: false,
        reExport: true,
        specifier: "#types",
        typeOnly: false,
      },
    ]);
  });
});
