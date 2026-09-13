import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type AliasExportIssue,
  findIssues,
} from "#scripts/check-alias-exports/rules.ts";

describe("check-alias-exports rules", () => {
  /** One source that imports byParent, plus whatever the test adds. */
  const importing = (extra: string): string =>
    `import { byParent } from "#shared/parents.ts";\n${extra}`;

  /** One source that imports TokenEntry, plus whatever the test adds: the
   * shared prefix behind every TokenEntry check below. */
  const importingToken = (extra: string): string =>
    `import { TokenEntry } from "#routes/tickets/token-utils.ts";\n${extra}`;

  /** The issues a TokenEntry-importing source holds, over the given extras. */
  const tokenIssues = (extra: string) => findIssues("token.ts", extra);

  /** What one CheckinEntry rename of TokenEntry looks like. */
  const expectCheckinEntryRename = (issues: AliasExportIssue[]): void => {
    expect(issues).toHaveLength(1);
    expect(issues[0]?.exported).toBe("CheckinEntry");
    expect(issues[0]?.target).toBe("TokenEntry");
  };

  test("flags an exported const whose whole value is one imported name", () => {
    const issues = findIssues(
      "one.ts",
      importing("export const getChildIds = byParent.getIds;\n"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.exported).toBe("getChildIds");
    expect(issues[0]?.target).toBe("byParent.getIds");
    expect(issues[0]?.line).toBe(2);
  });

  test("flags a renamed export clause of a local import", () => {
    expectCheckinEntryRename(
      tokenIssues(importingToken("export { TokenEntry as CheckinEntry };\n")),
    );
  });

  test("flags an export of a name the import itself renamed", () => {
    expectCheckinEntryRename(
      tokenIssues(
        `import { TokenEntry as CheckinEntry } from "#routes/tickets/token-utils.ts";\n` +
          "export { CheckinEntry };\n",
      ),
    );
  });

  test("flags an exported type alias of an imported type", () => {
    expectCheckinEntryRename(
      tokenIssues(importingToken("export type CheckinEntry = TokenEntry;\n")),
    );
  });

  test("flags a local type alias exported by name", () => {
    const issues = tokenIssues(
      importingToken(
        "type CheckinEntry = TokenEntry;\nexport { CheckinEntry };\n",
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.target).toBe("TokenEntry");
  });

  test("lets an exported type of its own shape stand", () => {
    expect(
      tokenIssues(importingToken("export type Local = { a: number };\n")),
    ).toEqual([]);
  });

  test("lets an exported type that specializes an import stand", () => {
    expect(
      tokenIssues(importingToken("export type Sized = Array<TokenEntry>;\n")),
    ).toEqual([]);
  });

  test("lets an exported function stand", () => {
    expect(
      tokenIssues(importingToken("export function helper(): void {}\n")),
    ).toEqual([]);
  });

  test("lets an unrenamed re-export from another module publish its name", () => {
    expect(
      findIssues(
        "three.ts",
        'export { TokenEntry } from "#routes/tickets/token-utils.ts";\n',
      ),
    ).toEqual([]);
  });

  test("flags a re-export that renames the foreign name", () => {
    const issues = findIssues(
      "seventeen.ts",
      'export { TokenEntry as CheckinEntry } from "#routes/tickets/token-utils.ts";\n',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.exported).toBe("CheckinEntry");
    expect(issues[0]?.target).toBe("TokenEntry");
    expect(issues[0]?.fix).toContain("its own module");
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

  test("flags a rename spelled as a string", () => {
    const issues = findIssues(
      "eight.ts",
      'import { TokenEntry } from "#routes/tickets/token-utils.ts";\n' +
        'export { TokenEntry as "checkin-entry" };\n',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.exported).toBe("checkin-entry");
    expect(issues[0]?.target).toBe("TokenEntry");
  });

  test("flags a computed member reached through an import, by its own text", () => {
    const issues = findIssues(
      "nine.ts",
      importing("export const getChildIds = byParent[choice];\n"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.target).toBe("byParent[choice]");
  });

  test("lets a member reached through a local value stand", () => {
    expect(
      findIssues(
        "eleven.ts",
        "const local = { getIds: 1 };\n" +
          "export const getChildIds = local.getIds;\n",
      ),
    ).toEqual([]);
  });

  test("lets a declared const with no value stand", () => {
    expect(
      findIssues("ten.ts", importing("export declare const choice: string;\n")),
    ).toEqual([]);
  });

  test("flags a member pulled from an import by destructuring,", () => {
    const issues = findIssues(
      "eleven.ts",
      importing("export const { getIds, both } = byParent;\n"),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]?.exported).toBe("getIds");
    expect(issues[0]?.target).toBe("byParent.getIds");
    expect(issues[1]?.exported).toBe("both");
    expect(issues[1]?.target).toBe("byParent.both");
  });

  test("flags an array element pulled from an import by destructuring", () => {
    const issues = findIssues(
      "twelve.ts",
      importing("export const [first, , third] = byParent;\n"),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]?.exported).toBe("first");
    expect(issues[0]?.target).toBe("byParent[0]");
    expect(issues[1]?.exported).toBe("third");
    expect(issues[1]?.target).toBe("byParent[2]");
  });

  test("lets a binding that adds something of its own stand", () => {
    expect(
      findIssues(
        "thirteen.ts",
        importing(
          "const { [name]: computed, withDefault = 3, ...rest } = byParent;\n",
        ),
      ),
    ).toEqual([]);
  });

  test("lets a destructuring from a local value stand", () => {
    expect(
      findIssues(
        "fourteen.ts",
        importing(
          "const local = { a: 1 };\n" +
            "const { a } = local;\n" +
            "export { a };\n",
        ),
      ),
    ).toEqual([]);
  });

  test("flags a local destructured member exported by name", () => {
    const issues = findIssues(
      "fifteen.ts",
      importing("const { getIds } = byParent;\nexport { getIds };\n"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.exported).toBe("getIds");
    expect(issues[0]?.target).toBe("byParent.getIds");
  });

  test("lets an exported let stand, because its target is no longer certain", () => {
    expect(
      findIssues(
        "sixteen.ts",
        importing("export let value = byParent;\nvalue = { getIds: 1 };\n"),
      ),
    ).toEqual([]);
  });

  /** What the checker says about the one finding a source holds, or null. */
  const soleFinding = (...content: [string, string]): unknown => {
    const issues = findIssues(content[0], importing(content[1]));
    return issues.length === 1 ? issues[0] : null;
  };

  test("flags a local const alias exported by name", () => {
    const issue = soleFinding(
      "twelve.ts",
      "const getChildIds = byParent.getIds;\nexport { getChildIds };\n",
    ) as { exported: string; line: number; target: string };
    expect(issue).not.toBeNull();
    expect(issue.exported).toBe("getChildIds");
    expect(issue.target).toBe("byParent.getIds");
    expect(issue.line).toBe(3);
  });

  test("flags a local const alias exported under a second new name", () => {
    const issue = soleFinding(
      "thirteen.ts",
      "const getChildIds = byParent.getIds;\nexport { getChildIds as Kids };\n",
    ) as { exported: string; target: string };
    expect(issue).not.toBeNull();
    expect(issue.exported).toBe("Kids");
    expect(issue.target).toBe("byParent.getIds");
  });

  test("flags an annotated alias that only repeats the imported type", () => {
    const issues = findIssues(
      "fourteen.ts",
      importing(
        "export const getChildIds: typeof byParent.getIds = byParent.getIds;\n",
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.target).toBe("byParent.getIds");
  });

  test("lets a local const built from a local stand, exported or not", () => {
    const content =
      "const local = { one: 1 };\n" +
      "const named = local.one;\n" +
      "export { named };\n";
    expect(findIssues("fifteen.ts", content)).toEqual([]);
  });

  test("lets a reassigned let stand, because its target is no longer certain", () => {
    const content = importing(
      "let getChildIds = byParent.getIds;\n" +
        "getChildIds = other;\n" +
        "export { getChildIds };\n",
    );
    expect(findIssues("sixteen.ts", content)).toEqual([]);
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
