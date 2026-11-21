import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  findIssues,
  type InternalImport,
  type InternalsContext,
  inBlackboxTree,
  internalCounts,
  internalImports,
} from "#scripts/check-test-internals/rules.ts";

const context: InternalsContext = {
  aliases: [
    { name: "#db/", target: "./src/shared/db/" },
    { name: "#dates", target: "./src/shared/dates.ts" },
    { name: "#routes", target: "./src/features/app/request.ts" },
    { name: "#test-utils/", target: "./test/test-utils/" },
  ],
  blackboxDir: "test/blackbox/",
  pure: new Set(["src/shared/dates.ts"]),
  seam: new Set(["src/features/app/request.ts"]),
  skippedTrees: [],
  sourceRoot: "src/",
};

const FILE = "test/shared/orders.test.ts";

/** A module's text from its lines. */
const source = (...lines: string[]): string => `${lines.join("\n")}\n`;

const db = (name: string): InternalImport["target"] => `src/shared/db/${name}`;

/** Each case: what the file holds, and the modules that it counts. */
const IMPORT_CASES: Record<string, [string, [number, string][]]> = {
  "a database module, with its line": [
    source('import { one } from "#db/client.ts";', "export { one };"),
    [[1, db("client.ts")]],
  ],
  "a dynamic import, with its own line": [
    source('export const load = () => import("#db/settings.ts");'),
    [[1, db("settings.ts")]],
  ],
  "a re-export that loads its source": [
    source('export { read } from "#db/read.ts";'),
    [[1, db("read.ts")]],
  ],
  "a relative import into the source tree": [
    source(
      'import { one } from "../../src/shared/db/client.ts";',
      "export { one };",
    ),
    [[1, db("client.ts")]],
  ],
  "one module once, and the modules in line order": [
    source(
      'import { two } from "#db/b.ts";',
      'import { one } from "#db/a.ts";',
      'export const later = () => import("#db/b.ts");',
      "export { one, two };",
    ),
    [
      [1, db("b.ts")],
      [2, db("a.ts")],
    ],
  ],
};

const FREE_CASES: Record<string, string> = {
  "a pure module, a seam module, and a test helper": source(
    'import { day } from "#dates";',
    'import { handleRequest } from "#routes";',
    'import { helper } from "#test-utils/helper.ts";',
    'import { expect } from "@std/expect";',
    "export { day, expect, handleRequest, helper };",
  ),
  "a type-only import": source(
    'import type { Row } from "#db/rows.ts";',
    'import { type Other } from "#db/other.ts";',
    "export type { Other, Row };",
  ),
};

describe("internalImports", () => {
  for (const [name, [content, expected]] of Object.entries(IMPORT_CASES)) {
    test(`counts ${name}`, () => {
      expect(
        internalImports(FILE, content, context).map(({ line, target }) => [
          line,
          target,
        ]),
      ).toEqual(expected);
    });
  }

  for (const [name, content] of Object.entries(FREE_CASES)) {
    test(`leaves ${name} free`, () => {
      expect(internalImports(FILE, content, context)).toEqual([]);
    });
  }
});

describe("internalCounts", () => {
  test("holds one count for each file that imports an internal, and no entry for a clean file", () => {
    const counted = source('import { a } from "#db/a.ts";', "export { a };");
    const clean = source('import { day } from "#dates";', "export { day };");
    expect(
      internalCounts(
        [
          { content: counted, file: "test/a.test.ts" },
          { content: clean, file: "test/b.test.ts" },
        ],
        context,
      ),
    ).toEqual({ "test/a.test.ts": 1 });
  });
});

describe("inBlackboxTree", () => {
  test("names the files under the black-box directory", () => {
    expect(inBlackboxTree("test/blackbox/login.test.ts", context)).toBe(true);
    expect(inBlackboxTree("test/shared/login.test.ts", context)).toBe(false);
  });
});

describe("findIssues", () => {
  const TWO = source(
    'import { a } from "#db/a.ts";',
    'import { b } from "#db/b.ts";',
    "export { a, b };",
  );
  const NONE = source("export {};");
  const REGISTRY = "scripts/check-test-internals/registry.json";
  const BLACKBOX = "test/blackbox/login.test.ts";

  /** The rule and the line of each finding. */
  const shape = (file: string, content: string, recorded: number | null) =>
    findIssues(
      file,
      content,
      recorded === null ? {} : { [file]: recorded },
      context,
    ).map((finding) => [finding.rule, finding.line]);

  test("passes a file that holds its recorded count", () => {
    expect(shape(FILE, TWO, 2)).toEqual([]);
  });

  test("fails the imports past the recorded count, naming the module", () => {
    expect(findIssues(FILE, TWO, { [FILE]: 1 }, context)).toEqual([
      {
        fix: 'drive the app through test/blackbox/driver.ts, or add the line "// effects: pure" to the module when it is pure',
        line: 2,
        problem: `imports ${db("b.ts")}, a src module that is not pure`,
        rule: "internal-import",
      },
    ]);
  });

  test("fails every import of a file that no entry covers", () => {
    expect(shape(FILE, TWO, null)).toEqual([
      ["internal-import", 1],
      ["internal-import", 2],
    ]);
  });

  test("asks for the record when the count has fallen", () => {
    expect(findIssues(FILE, TWO, { [FILE]: 5 }, context)).toEqual([
      {
        fix: "run `deno task check:test-internals --update` to record the count",
        line: 1,
        problem:
          "imports 2 src modules that are not pure, fewer than the recorded 5",
        rule: "improved",
      },
    ]);
  });

  test("asks for the entry of a clean file to go", () => {
    expect(findIssues(FILE, NONE, { [FILE]: 1 }, context)).toEqual([
      {
        fix: `delete the entry in ${REGISTRY}`,
        line: 1,
        problem: "holds no import of a src module that is not pure",
        rule: "stale-entry",
      },
    ]);
  });

  test("says nothing about a clean file with no entry", () => {
    expect(shape(FILE, NONE, null)).toEqual([]);
  });

  test("fails every import in the black-box tree, whatever the registry holds", () => {
    expect(shape(BLACKBOX, TWO, 2)).toEqual([
      ["stale-entry", 1],
      ["blackbox-import", 1],
      ["blackbox-import", 2],
    ]);
  });

  test("passes a clean file in the black-box tree", () => {
    expect(shape(BLACKBOX, NONE, null)).toEqual([]);
  });
});
