import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { findIssues } from "#scripts/check-alias-exports/rules.ts";

describe("check-alias-exports rules", () => {
  test("flags an exported const whose whole value is one imported name", () => {
    const issues = findIssues(
      "one.ts",
      'import { byParent } from "#shared/parents.ts";\n' +
        "export const getChildIds = byParent.getIds;\n",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.exported).toBe("getChildIds");
    expect(issues[0]?.target).toBe("byParent.getIds");
    expect(issues[0]?.line).toBe(2);
  });

  test("flags a renamed export clause of a local import", () => {
    const issues = findIssues(
      "two.ts",
      'import { TokenEntry } from "#routes/tickets/token-utils.ts";\n' +
        "export { TokenEntry as CheckinEntry };\n",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.exported).toBe("CheckinEntry");
    expect(issues[0]?.target).toBe("TokenEntry");
  });

  test("lets a re-export from another module publish its name", () => {
    expect(
      findIssues(
        "three.ts",
        'export { TokenEntry as CheckinEntry } from "#routes/tickets/token-utils.ts";\n',
      ),
    ).toEqual([]);
  });

  test("lets a wrapper that adds something stand", () => {
    const content =
      'import { byParent } from "#shared/parents.ts";\n' +
      "export const ok = makeOutcome(true);\n" +
      "export const ids = byParent.getIds();\n" +
      "function makeOutcome(value: boolean) {\n  return { value };\n}\n";
    expect(findIssues("four.ts", content)).toEqual([]);
  });

  test("lets a declared type contract stand", () => {
    const content =
      'import system from "./en/system.json" with { type: "json" };\n' +
      "export const SYSTEM_MESSAGES: Messages = system;\n";
    expect(findIssues("five.ts", content)).toEqual([]);
  });

  test("lets a local value, and an import published unrenamed, stand", () => {
    const content =
      'import { compact } from "#fp";\n' +
      "const local = 3;\n" +
      "export const total = local;\n" +
      "export { compact };\n";
    expect(findIssues("six.ts", content)).toEqual([]);
  });

  test("reports each finding with the fix a reader needs", () => {
    const [issue] = findIssues(
      "seven.ts",
      'import { byParent } from "#shared/parents.ts";\n' +
        "export const getChildIds = byParent.getIds;\n",
    );
    expect(issue?.problem).toBe(
      '"getChildIds" renames the imported byParent.getIds',
    );
    expect(issue?.fix).toBe(
      "export byParent.getIds itself, and let callers use it",
    );
    expect(issue?.rule).toBe("alias-export");
  });
});
