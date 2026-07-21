import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { tempDir } from "#test-utils/files.ts";
import {
  detectAliasing,
  detectModuleLevelLet,
  detectRelativeImport,
  detectThenUsage,
  extractExports,
  findInMemoryStateViolations,
  findRawDbViolation,
  findTestOnlyExportViolations,
  getAllFilesWithExt,
  importedSymbolsOf,
  isPrimarilyReExportModule,
  isSymbolImported,
  isUsedInProductionCode,
  isUsedInSameFile,
  isUsedInTests,
} from "./detectors.ts";

/**
 * Fixture-driven tests for the code-quality detectors. The integration test
 * (`../code-quality.test.ts`) only asserts the *live* tree is clean, which
 * cannot distinguish a working detector from a broken one. These tests feed each
 * detector a known-bad input and assert it fires, and a known-good input and
 * assert it stays quiet — so a regression in the detection logic fails here.
 */

const mapOf = (entries: [string, string][]): Map<string, string> =>
  new Map(entries);

describe("getAllFilesWithExt", () => {
  test("collects matching files recursively and ignores other extensions", async () => {
    using temp = tempDir();
    const dir = temp.path;
    await Deno.mkdir(join(dir, "sub"));
    await Deno.writeTextFile(join(dir, "a.ts"), "");
    await Deno.writeTextFile(join(dir, "b.tsx"), "");
    await Deno.writeTextFile(join(dir, "c.txt"), "");
    await Deno.writeTextFile(join(dir, "sub", "d.ts"), "");
    await Deno.writeTextFile(join(dir, "sub", "e.tsx"), "");

    const ts = await getAllFilesWithExt(dir, ".ts");
    expect(ts.sort()).toEqual([join(dir, "a.ts"), join(dir, "sub", "d.ts")]);

    const tsx = await getAllFilesWithExt(dir, ".tsx");
    expect(tsx.sort()).toEqual([join(dir, "b.tsx"), join(dir, "sub", "e.tsx")]);
  });

  test("returns an empty list for a directory with no matches", async () => {
    using temp = tempDir();
    await Deno.writeTextFile(join(temp.path, "only.md"), "");
    expect(await getAllFilesWithExt(temp.path, ".ts")).toEqual([]);
  });
});

describe("findInMemoryStateViolations", () => {
  test("flags a module-level Map assignment", () => {
    expect(
      findInMemoryStateViolations(
        "shared/x.ts",
        "const cache = new Map();",
        [],
      ),
    ).toEqual(["shared/x.ts: Module-level Map (use database instead)"]);
  });

  test("flags a module-level Set assignment", () => {
    expect(
      findInMemoryStateViolations("shared/x.ts", "let seen = new Set();", []),
    ).toEqual(["shared/x.ts: Module-level Set (use database instead)"]);
  });

  test("flags a module-level typed Map declaration", () => {
    expect(
      findInMemoryStateViolations(
        "shared/x.ts",
        "const cache: Map<string, number> = build();",
        [],
      ),
    ).toEqual(["shared/x.ts: Module-level typed Map (use database instead)"]);
  });

  test("flags a module-level typed Set declaration", () => {
    expect(
      findInMemoryStateViolations(
        "shared/x.ts",
        "export const seen: Set<string> = build();",
        [],
      ),
    ).toEqual(["shared/x.ts: Module-level typed Set (use database instead)"]);
  });

  test("does not flag clean content", () => {
    expect(
      findInMemoryStateViolations("shared/x.ts", "const x = 1;", []),
    ).toEqual([]);
  });

  test("does not flag an indented (non-module-level) Map", () => {
    expect(
      findInMemoryStateViolations(
        "shared/x.ts",
        "function f() {\n  const m = new Map();\n}",
        [],
      ),
    ).toEqual([]);
  });

  test("skips files on the allow-list even when they match", () => {
    expect(
      findInMemoryStateViolations("shared/x.ts", "const cache = new Map();", [
        "shared/x.ts",
      ]),
    ).toEqual([]);
  });
});

describe("findRawDbViolation", () => {
  test("flags a direct getDb().execute call", () => {
    expect(
      findRawDbViolation("features/y.ts", "await getDb().execute(sql);", []),
    ).toBe(
      "features/y.ts: use execute()/queryOne()/queryAll()/executeBatch() from #shared/db/client.ts instead of getDb().execute/.batch",
    );
  });

  test("flags a direct getDb().batch call", () => {
    expect(
      findRawDbViolation("features/y.ts", "await getDb().batch(stmts);", []),
    ).toContain("instead of getDb().execute/.batch");
  });

  test("returns null for clean content", () => {
    expect(findRawDbViolation("features/y.ts", "await execute(sql);", [])).toBe(
      null,
    );
  });

  test("returns null for a file under an allowed prefix", () => {
    expect(
      findRawDbViolation("shared/db/migrations/001.ts", "getDb().execute(x);", [
        "shared/db/migrations/",
      ]),
    ).toBe(null);
  });
});

describe("detectAliasing", () => {
  test("flags an identifier-to-identifier const alias", () => {
    expect(detectAliasing("src/a.ts", "const myFn = someFn;", 7)).toBe(
      "src/a.ts:7: const myFn = someFn (use import { someFn as myFn } instead)",
    );
  });

  test("flags an exported alias", () => {
    expect(detectAliasing("src/a.ts", "export const a = b;", 3)).toBe(
      "src/a.ts:3: const a = b (use import { b as a } instead)",
    );
  });

  test("does not flag assignment of a literal", () => {
    expect(detectAliasing("src/a.ts", "const n = 123;", 1)).toBe(null);
  });

  test("does not flag a call expression", () => {
    expect(detectAliasing("src/a.ts", "const x = build();", 1)).toBe(null);
  });

  test("does not flag a let binding", () => {
    expect(detectAliasing("src/a.ts", "let x = y;", 1)).toBe(null);
  });
});

describe("detectModuleLevelLet", () => {
  test("flags a module-level let", () => {
    expect(detectModuleLevelLet("src/a.ts", "let counter = 0;", 7)).toBe(
      "src/a.ts:7: let counter = 0;... (use const with once()/lazyRef())",
    );
  });

  test("flags an exported let", () => {
    expect(detectModuleLevelLet("src/a.ts", "export let x = 1;", 2)).toBe(
      "src/a.ts:2: export let x = 1;... (use const with once()/lazyRef())",
    );
  });

  test("truncates the reported line to 50 characters", () => {
    const long = `let x = ${"a".repeat(80)};`;
    expect(detectModuleLevelLet("src/a.ts", long, 1)).toBe(
      `src/a.ts:1: ${long.slice(0, 50)}... (use const with once()/lazyRef())`,
    );
  });

  test("does not flag an indented let", () => {
    expect(detectModuleLevelLet("src/a.ts", "  let x = 1;", 1)).toBe(null);
  });

  test("does not flag const", () => {
    expect(detectModuleLevelLet("src/a.ts", "const x = 1;", 1)).toBe(null);
  });

  test("does not flag an identifier that merely starts with 'let'", () => {
    expect(detectModuleLevelLet("src/a.ts", "letter = 1;", 1)).toBe(null);
  });
});

describe("detectThenUsage", () => {
  test("flags a .then() call and trims leading whitespace", () => {
    expect(detectThenUsage("src/a.ts", "  promise.then(handle);", 4)).toBe(
      "src/a.ts:4: promise.then(handle);... (use async/await instead)",
    );
  });

  test("flags .then with whitespace before the paren", () => {
    expect(detectThenUsage("src/a.ts", "p.then ();", 1)).toBe(
      "src/a.ts:1: p.then ();... (use async/await instead)",
    );
  });

  test("returns null for async/await code", () => {
    expect(detectThenUsage("src/a.ts", "await promise;", 1)).toBe(null);
  });

  test("returns null when 'then' is not a method call", () => {
    expect(detectThenUsage("src/a.ts", "const then = 1;", 1)).toBe(null);
  });
});

describe("detectRelativeImport", () => {
  test("flags a static ../ import", () => {
    expect(
      detectRelativeImport("src/a.ts", 'import { x } from "../b.ts";', 4),
    ).toBe(
      'src/a.ts:4: import { x } from "../b.ts";... (use a # alias instead of a ../ relative import)',
    );
  });

  test("flags a multi-line static import whose from clause walks up", () => {
    expect(
      detectRelativeImport("src/a.ts", '} from "../shared/b.ts";', 7),
    ).toBe(
      'src/a.ts:7: } from "../shared/b.ts";... (use a # alias instead of a ../ relative import)',
    );
  });

  test("flags a dynamic await import with ../", () => {
    expect(
      detectRelativeImport(
        "src/a.ts",
        'const { x } = await import("../b.ts");',
        2,
      ),
    ).toBe(
      'src/a.ts:2: const { x } = await import("../b.ts");... (use a # alias instead of a ../ relative import)',
    );
  });

  test("flags a bare dynamic import() with ../", () => {
    expect(
      detectRelativeImport("src/a.ts", 'import("../b.ts").then(() => {});', 3),
    ).toBe(
      'src/a.ts:3: import("../b.ts").then(() => {});... (use a # alias instead of a ../ relative import)',
    );
  });

  test("flags a bare side-effect import with ../", () => {
    expect(detectRelativeImport("src/a.ts", 'import "../b.ts";', 5)).toBe(
      'src/a.ts:5: import "../b.ts";... (use a # alias instead of a ../ relative import)',
    );
  });

  test("flags a side-effect import with leading whitespace", () => {
    expect(detectRelativeImport("src/a.ts", '  import "../b.ts";', 1)).toBe(
      'src/a.ts:1: import "../b.ts";... (use a # alias instead of a ../ relative import)',
    );
  });

  test("does not flag a sibling side-effect import", () => {
    expect(detectRelativeImport("src/a.ts", 'import "./b.ts";', 1)).toBe(null);
  });

  test("flags the ./../ form", () => {
    expect(
      detectRelativeImport("src/a.ts", 'import { x } from "./../b.ts";', 1),
    ).toBe(
      'src/a.ts:1: import { x } from "./../b.ts";... (use a # alias instead of a ../ relative import)',
    );
  });

  test("does not flag a sibling ./ import", () => {
    expect(
      detectRelativeImport("src/a.ts", 'import { x } from "./b.ts";', 1),
    ).toBe(null);
  });

  test("does not flag a # alias import", () => {
    expect(
      detectRelativeImport("src/a.ts", 'import { x } from "#shared/b.ts";', 1),
    ).toBe(null);
  });

  test("does not flag a package import", () => {
    expect(
      detectRelativeImport("src/a.ts", 'import { x } from "valibot";', 1),
    ).toBe(null);
  });
});

describe("extractExports", () => {
  test("captures const, let, function, async function and class exports", () => {
    const content = [
      "export const foo = 1;",
      "export let bar = 2;",
      "export function baz() {}",
      "export async function qux() {}",
      "export class Cls {}",
    ].join("\n");
    expect(extractExports(content)).toEqual([
      "foo",
      "bar",
      "baz",
      "qux",
      "Cls",
    ]);
  });

  test("ignores re-exports", () => {
    expect(extractExports('export { x } from "./y.ts";')).toEqual([]);
  });

  test("returns an empty list when there are no exports", () => {
    expect(extractExports("const internal = 1;")).toEqual([]);
  });
});

describe("isUsedInSameFile", () => {
  test("detects a usage beyond the export definition line", () => {
    const content = "export const foo = 1;\nfoo();\nconst other = 2;";
    expect(isUsedInSameFile("foo", content)).toBe(true);
  });

  test("detects property-access usage", () => {
    expect(isUsedInSameFile("foo", "export const foo = {};\nfoo.bar;")).toBe(
      true,
    );
  });

  test("returns false when only the definition line mentions the symbol", () => {
    expect(isUsedInSameFile("foo", "export const foo = 1;")).toBe(false);
  });

  test("returns false when the symbol never appears", () => {
    expect(isUsedInSameFile("foo", "const bar = 1;\nbar();")).toBe(false);
  });
});

describe("isSymbolImported", () => {
  test("detects a named import", () => {
    expect(isSymbolImported("foo", 'import { foo, bar } from "./x.ts";')).toBe(
      true,
    );
  });

  test("returns false when the symbol is only defined, not imported", () => {
    expect(isSymbolImported("foo", "const foo = 1;")).toBe(false);
  });

  test("returns false when a different symbol is imported", () => {
    expect(isSymbolImported("foo", 'import { bar } from "./x.ts";')).toBe(
      false,
    );
  });

  test("detects a destructured dynamic import", () => {
    expect(
      isSymbolImported(
        "foo",
        'const { foo: renamed } = await import("./x.ts");',
      ),
    ).toBe(true);
  });

  test("returns false when a dynamic import destructures other symbols", () => {
    expect(
      isSymbolImported("foo", 'const { bar } = await import("./x.ts");'),
    ).toBe(false);
  });

  test("detects a lazyExport route-table entry by its quoted name", () => {
    expect(
      isSymbolImported(
        "routeFoo",
        'lazyExport(() => import("#routes/foo.ts"), "routeFoo"),',
      ),
    ).toBe(true);
  });

  test("detects a lazyExport entry split across lines", () => {
    expect(
      isSymbolImported(
        "routeFoo",
        'lazyExport(\n  () => import("#routes/foo.ts"),\n  "routeFoo",\n),',
      ),
    ).toBe(true);
  });

  test("does not count an alias target as usage of an unrelated export", () => {
    expect(
      isSymbolImported(
        "renamed",
        'const { foo: renamed } = await import("./x.ts");',
      ),
    ).toBe(false);
    expect(
      isSymbolImported("baz", 'import { bar as baz } from "./x.ts";'),
    ).toBe(false);
  });

  test("reads through an inline type keyword to the imported name", () => {
    expect(
      isSymbolImported("Foo", 'import { type Foo, bar } from "./x.ts";'),
    ).toBe(true);
  });
});

describe("importedSymbolsOf", () => {
  test("collects each import item's source-side name across the corpus", () => {
    const corpus = mapOf([
      ["a.ts", 'import { foo, bar as baz } from "./x.ts";\nconst y = 1;'],
      ["b.ts", 'import {\n  quux,\n} from "./y.ts";'],
    ]);
    // `bar as baz` names the export `bar`; the alias `baz` must not count.
    expect(importedSymbolsOf(corpus)).toEqual(new Set(["bar", "foo", "quux"]));
  });

  test("ignores words outside import clauses, matching isSymbolImported", () => {
    const corpus = mapOf([["a.ts", "const loose = 1;\nexport { loose };"]]);
    expect(importedSymbolsOf(corpus).has("loose")).toBe(false);
    expect(isSymbolImported("loose", "const loose = 1;")).toBe(false);
  });

  test("collects symbols pulled in via destructured dynamic imports", () => {
    const corpus = mapOf([
      ["a.ts", 'const { lazyThing } = await import("./x.ts");'],
    ]);
    expect(importedSymbolsOf(corpus)).toEqual(new Set(["lazyThing"]));
  });

  test("collects only the source-side name of an aliased dynamic import", () => {
    const corpus = mapOf([
      ["a.ts", 'const { foo: renamed } = await import("./x.ts");'],
    ]);
    expect(importedSymbolsOf(corpus)).toEqual(new Set(["foo"]));
  });

  test("tokenizes a corpus only once, serving repeat queries from the cache", () => {
    const corpus = mapOf([["a.ts", 'import { once } from "./x.ts";']]);
    expect(importedSymbolsOf(corpus)).toBe(importedSymbolsOf(corpus));
  });
});

describe("isUsedInProductionCode", () => {
  test("true when used within the same source file", () => {
    expect(
      isUsedInProductionCode(
        "foo",
        "a.ts",
        mapOf([["a.ts", "export const foo = 1;\nfoo();"]]),
        mapOf([]),
      ),
    ).toBe(true);
  });

  test("true when imported by another .ts source", () => {
    expect(
      isUsedInProductionCode(
        "foo",
        "a.ts",
        mapOf([
          ["a.ts", "export const foo = 1;"],
          ["b.ts", 'import { foo } from "./a.ts";'],
        ]),
        mapOf([]),
      ),
    ).toBe(true);
  });

  test("true when imported by a .tsx template", () => {
    expect(
      isUsedInProductionCode(
        "foo",
        "a.ts",
        mapOf([["a.ts", "export const foo = 1;"]]),
        mapOf([["t.tsx", 'import { foo } from "./a.ts";']]),
      ),
    ).toBe(true);
  });

  test("false when used nowhere in production", () => {
    expect(
      isUsedInProductionCode(
        "foo",
        "a.ts",
        mapOf([
          ["a.ts", "export const foo = 1;"],
          ["b.ts", "const unrelated = 1;"],
        ]),
        mapOf([["t.tsx", "const x = 1;"]]),
      ),
    ).toBe(false);
  });
});

describe("isUsedInTests", () => {
  test("true when a test file imports the symbol", () => {
    expect(
      isUsedInTests(
        "foo",
        mapOf([["x.test.ts", 'import { foo } from "../a.ts";']]),
      ),
    ).toBe(true);
  });

  test("false when no test imports the symbol", () => {
    expect(isUsedInTests("foo", mapOf([["x.test.ts", "const y = 1;"]]))).toBe(
      false,
    );
  });
});

describe("isPrimarilyReExportModule", () => {
  test("false when there are no re-exports", () => {
    expect(isPrimarilyReExportModule("export const x = 1;")).toBe(false);
  });

  test("true when re-exports dominate", () => {
    const content = 'export { a } from "./a.ts";\nexport { b } from "./b.ts";';
    expect(isPrimarilyReExportModule(content)).toBe(true);
  });

  test("false when direct exports tie the re-export count", () => {
    const content = 'export { a } from "./a.ts";\nexport const b = 1;';
    expect(isPrimarilyReExportModule(content)).toBe(false);
  });
});

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
