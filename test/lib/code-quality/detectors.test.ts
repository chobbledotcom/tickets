import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  detectAliasing,
  detectModuleLevelLet,
  detectThenUsage,
  extractCallSites,
  extractExports,
  findInMemoryStateViolations,
  findRawDbViolation,
  findRedundantArg,
  findTestOnlyExportViolations,
  getAllFilesWithExt,
  isConstantLiteral,
  isPrimarilyReExportModule,
  isSymbolImported,
  isUsedInProductionCode,
  isUsedInSameFile,
  isUsedInTests,
  parseArgList,
  type Site,
  skipComment,
  skipString,
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
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(dir, "sub"));
      await Deno.writeTextFile(join(dir, "a.ts"), "");
      await Deno.writeTextFile(join(dir, "b.tsx"), "");
      await Deno.writeTextFile(join(dir, "c.txt"), "");
      await Deno.writeTextFile(join(dir, "sub", "d.ts"), "");
      await Deno.writeTextFile(join(dir, "sub", "e.tsx"), "");

      const ts = await getAllFilesWithExt(dir, ".ts");
      expect(ts.sort()).toEqual([join(dir, "a.ts"), join(dir, "sub", "d.ts")]);

      const tsx = await getAllFilesWithExt(dir, ".tsx");
      expect(tsx.sort()).toEqual([
        join(dir, "b.tsx"),
        join(dir, "sub", "e.tsx"),
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  test("returns an empty list for a directory with no matches", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(dir, "only.md"), "");
      expect(await getAllFilesWithExt(dir, ".ts")).toEqual([]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
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

describe("isConstantLiteral", () => {
  const cases: [string, boolean][] = [
    ['"str"', true],
    ["'str'", true],
    ["`tpl`", true],
    ["123", true],
    ["-5", true],
    ["0", true],
    ["true", true],
    ["false", true],
    ["null", true],
    ["undefined", true],
    ["variable", false],
    ["build()", false],
    ["a + b", false],
  ];
  for (const [arg, expected] of cases) {
    test(`${arg} -> ${expected}`, () => {
      expect(isConstantLiteral(arg)).toBe(expected);
    });
  }
});

describe("extractCallSites", () => {
  const cases: {
    name: string;
    src: string;
    expected: ReturnType<typeof extractCallSites>;
  }[] = [
    {
      expected: [{ args: ["1", "2"], line: 1, name: "foo" }],
      name: "a simple call with two arguments",
      src: "foo(1, 2)",
    },
    {
      expected: [{ args: ['"a, b"', "c"], line: 1, name: "foo" }],
      name: "a comma inside a double-quoted string (not an arg separator)",
      src: 'foo("a, b", c)',
    },
    {
      expected: [{ args: ["'x'", "`y`"], line: 1, name: "foo" }],
      name: "single-quoted and template-literal arguments",
      src: "foo('x', `y`)",
    },
    {
      expected: [{ args: ['"a\\"b"'], line: 1, name: "foo" }],
      name: "an escaped quote inside a string",
      src: 'foo("a\\"b")',
    },
    {
      expected: [{ args: ['"a$b"'], line: 1, name: "foo" }],
      name: "a double-quoted string containing a lone $",
      src: 'foo("a$b")',
    },
    {
      expected: [
        { args: ["bar(1, 2)", "[3, 4]", "{a: 5}"], line: 1, name: "foo" },
        { args: ["1", "2"], line: 1, name: "bar" },
      ],
      // The nested `bar(...)` call is also discovered; foo's own arguments keep
      // their nested commas because brackets bump the depth past the top level.
      name: "nested calls, arrays and objects (depth tracking)",
      src: "foo(bar(1, 2), [3, 4], {a: 5})",
    },
    {
      expected: [{ args: ["1"], line: 1, name: "foo" }],
      name: "a keyword followed by a paren is not a call",
      src: "if (cond) foo(1)",
    },
    {
      expected: [{ args: ["a"], line: 1, name: "bar" }],
      name: "a function declaration name is not a call",
      src: "function foo(a) { bar(a); }",
    },
    {
      expected: [{ args: ["1"], line: 1, name: "bar" }],
      name: "an identifier not followed by a paren is not a call",
      src: "const x = foo; bar(1)",
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      name: "whitespace between the name and the paren",
      src: "foo ()",
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      name: "an empty argument list",
      src: "foo()",
    },
    {
      expected: [{ args: ["a"], line: 1, name: "foo" }],
      name: "a trailing empty argument is dropped",
      src: "foo(a, )",
    },
    {
      expected: [{ args: ["2"], line: 2, name: "bar" }],
      name: "a line comment hides a call; line numbers are resolved",
      src: "// foo(1)\nbar(2)",
    },
    {
      expected: [{ args: ["2"], line: 1, name: "bar" }],
      name: "a block comment hides a call",
      src: "/* foo(1) */ bar(2)",
    },
    {
      expected: [{ args: ["x /* , */", "y"], line: 1, name: "foo" }],
      // A comma inside a comment must not split the argument list: the comment
      // text stays in the arg slice, but there are still exactly two arguments.
      name: "a comma inside a comment does not split arguments",
      src: "foo(x /* , */, y)",
    },
    {
      expected: [
        { args: ["1"], line: 2, name: "foo" },
        { args: ["2"], line: 4, name: "bar" },
      ],
      name: "two calls on different lines",
      src: "\nfoo(1)\n\nbar(2)",
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      name: "an unterminated string stops cleanly",
      src: 'foo("abc',
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      name: "an unterminated argument list stops cleanly",
      src: "foo(a",
    },
    {
      expected: [],
      name: "an unterminated line comment yields no calls",
      src: "// foo(1)",
    },
    {
      expected: [],
      name: "an unterminated block comment yields no calls",
      src: "/* foo(1)",
    },
    {
      expected: [{ args: ['"bar()"'], line: 1, name: "foo" }],
      // A call-like sequence inside a double-quoted string must stay hidden.
      name: "a call inside a double-quoted string is not detected",
      src: 'foo("bar()")',
    },
    {
      expected: [{ args: ["'baz()'"], line: 1, name: "foo" }],
      name: "a call inside a single-quoted string is not detected",
      src: "foo('baz()')",
    },
    {
      expected: [{ args: ["`qux()`"], line: 1, name: "foo" }],
      name: "a call inside a template literal is not detected",
      src: "foo(`qux()`)",
    },
    {
      expected: [{ args: ["1"], line: 1, name: "foo" }],
      // Scanning must resume *at* the end of a comment, not be advanced past it:
      // an off-by addition here would land mid-token and miss the real call.
      name: "scanning resumes exactly after a mid-line comment",
      src: "ab /* c */ foo(1)",
    },
    {
      expected: [{ args: ["1"], line: 1, name: "foo" }],
      name: "scanning resumes exactly after a mid-line string",
      src: "ab 'xxxx' foo(1)",
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      // The "function" guard must be cleared after a string, or the following
      // call would be wrongly treated as a function declaration name.
      name: "a string clears the preceding-word guard",
      src: 'function "s" foo()',
    },
    {
      expected: [],
      // The preceding word is replaced, not accumulated: with replacement the
      // most recent word is "function", which suppresses this call (no calls).
      // Under an accumulating mutant the guard reads "afunction" and the call
      // would wrongly be reported.
      name: "the preceding-word guard is replaced, not accumulated",
      src: "a function foo()",
    },
    {
      expected: [{ args: [], line: 1, name: "foo" }],
      // A punctuation token clears the guard: `function;` does not suppress the
      // following call the way `function foo()` would.
      name: "punctuation clears the preceding-word guard",
      src: "function; foo()",
    },
  ];
  for (const { name, src, expected } of cases) {
    test(name, () => {
      expect(extractCallSites(src)).toEqual(expected);
    });
  }

  test("skips template substitutions: nested braces, strings and templates", () => {
    // Source text:  foo(`a$b${ {x:"q"} }${'s'}${`t`}`)
    // The whole backtick template is one argument; the `bar` call and comma-like
    // characters inside `${...}` must NOT leak out as separate calls/args.
    const template = "`a$b${ {x:\"q\"} }${'s'}${`t`}`";
    const src = `foo(${template})`;
    expect(extractCallSites(src)).toEqual([
      { args: [template], line: 1, name: "foo" },
    ]);
  });

  test("handles an unterminated template substitution", () => {
    // Source text:  foo(`${x`)   — the inner backtick opens a nested template
    // that never closes, so the whole thing is consumed as one (empty) call.
    const src = "foo(`${x`)";
    expect(extractCallSites(src)).toEqual([{ args: [], line: 1, name: "foo" }]);
  });
});

describe("findRedundantArg", () => {
  const site = (args: string[], line = 1, file = "a.ts"): Site => ({
    args,
    file,
    line,
  });

  test("ignores built-in callees like padStart", () => {
    const sites = [site(["2", "'0'"]), site(["2", "'0'"]), site(["2", "'0'"])];
    expect(findRedundantArg("padStart", sites)).toBe(null);
  });

  test("ignores callees with fewer than three call sites", () => {
    expect(findRedundantArg("foo", [site(["1"]), site(["1"])])).toBe(null);
  });

  test("flags a position that is always the same constant", () => {
    const sites = [
      site(["1"], 10, "a.ts"),
      site(["1"], 20, "b.ts"),
      site(["1"], 30, "c.ts"),
    ];
    expect(findRedundantArg("foo", sites)).toBe(
      "foo() arg #0 is always 1 across 3 calls (a.ts:10, b.ts:20, c.ts:30) — use a default parameter or constant",
    );
  });

  test("respects the allowed-constant-args list (parseInt radix)", () => {
    const sites = [site(["x", "10"]), site(["y", "10"]), site(["z", "10"])];
    expect(findRedundantArg("parseInt", sites)).toBe(null);
  });

  test("does not flag a position holding non-literal arguments", () => {
    const sites = [site(["a"]), site(["b"]), site(["c"])];
    expect(findRedundantArg("foo", sites)).toBe(null);
  });

  test("does not flag constants that differ across call sites", () => {
    const sites = [site(["1"]), site(["2"]), site(["3"])];
    expect(findRedundantArg("foo", sites)).toBe(null);
  });

  test("checks later positions when an earlier one varies", () => {
    const sites = [
      site(["a", "9"], 1, "a.ts"),
      site(["b", "9"], 2, "a.ts"),
      site(["c", "9"], 3, "a.ts"),
    ];
    expect(findRedundantArg("foo", sites)).toBe(
      "foo() arg #1 is always 9 across 3 calls (a.ts:1, a.ts:2, a.ts:3) — use a default parameter or constant",
    );
  });

  test("only inspects positions present in every call site", () => {
    // shared arity is 1, so the differing second arg of the wider sites is
    // never considered; arg #0 is always "1" and is flagged.
    const sites = [site(["1", "2"]), site(["1"]), site(["1", "9"])];
    expect(findRedundantArg("foo", sites)).toContain("arg #0 is always 1");
  });

  test("appends an ellipsis when there are more than four call sites", () => {
    const sites = [
      site(["1"], 1, "f1.ts"),
      site(["1"], 1, "f2.ts"),
      site(["1"], 1, "f3.ts"),
      site(["1"], 1, "f4.ts"),
      site(["1"], 1, "f5.ts"),
    ];
    expect(findRedundantArg("foo", sites)).toBe(
      "foo() arg #0 is always 1 across 5 calls (f1.ts:1, f2.ts:1, f3.ts:1, f4.ts:1, ...) — use a default parameter or constant",
    );
  });
});

/**
 * Direct tokenizer tests. `extractCallSites` is too forgiving to expose these
 * helpers' internal edge cases — it always recovers at the next closing quote —
 * so the index/argument contracts are asserted here. (Same rationale as the
 * codebase's other "internal parser exposed for unit testing only".)
 */
describe("skipString", () => {
  test("returns the index just past a simple string", () => {
    expect(skipString('"abc"', 0)).toBe(5);
  });

  test("skips an escaped character rather than closing on it", () => {
    // The backslash escapes the next char; without skipping two, the closing
    // quote would be misread (and the index would be wrong).
    expect(skipString('"a\\nb"', 0)).toBe(6);
  });

  test("skips a template substitution", () => {
    expect(skipString("`${x}`", 0)).toBe(6);
  });

  test("ends a template at its closing backtick, leaving trailing code", () => {
    // Stops just past the closing backtick (index 6) rather than treating the
    // substitution's contents as nested strings and running into `bar`.
    expect(skipString("`${a}`bar", 0)).toBe(6);
  });

  test("tracks brace depth inside a substitution", () => {
    // The inner `{ ... }` must raise the depth so the substitution ends at the
    // outer `}`, not the inner one (which would expose the inner backtick).
    expect(skipString("`${ { `x` } }`", 0)).toBe(14);
  });

  test("skips a double-quoted nested string inside a substitution", () => {
    expect(skipString('`${ "}" + `x` }`', 0)).toBe(16);
  });

  test("skips a single-quoted nested string inside a substitution", () => {
    expect(skipString("`${ '}' }`", 0)).toBe(10);
  });

  test("skips a backtick nested string inside a substitution", () => {
    expect(skipString("`${ `}` }`", 0)).toBe(10);
  });

  test("treats a lone $ in a template as literal", () => {
    expect(skipString("`a$b`", 0)).toBe(5);
  });

  test("treats $ in a non-template string as literal", () => {
    expect(skipString('"a$b"', 0)).toBe(5);
  });

  test("returns past the end for an unterminated string", () => {
    expect(skipString('"abc', 0)).toBe(4);
  });
});

describe("skipComment", () => {
  test("skips a line comment up to the newline", () => {
    expect(skipComment("// x\ny", 0)).toBe(4);
  });

  test("skips a line comment running to end of input", () => {
    expect(skipComment("// x", 0)).toBe(4);
  });

  test("skips a block comment", () => {
    expect(skipComment("/* x */y", 0)).toBe(7);
  });

  test("ends a block comment only at star-slash, not a bare slash", () => {
    expect(skipComment("/* a/ */", 0)).toBe(8);
  });

  test("does not treat a lone slash as the start of a comment", () => {
    expect(skipComment("/x", 0)).toBe(0);
  });

  test("returns the index unchanged for a non-comment slash", () => {
    expect(skipComment("x/y", 1)).toBe(1);
  });
});

describe("parseArgList", () => {
  test("splits top-level comma-separated arguments", () => {
    expect(parseArgList("(a, b)", 0).args).toEqual(["a", "b"]);
  });

  test("does not split on a comma inside a single-quoted string", () => {
    expect(parseArgList("('a,b')", 0).args).toEqual(["'a,b'"]);
  });

  test("does not split on a comma inside a double-quoted string", () => {
    expect(parseArgList('("a,b")', 0).args).toEqual(['"a,b"']);
  });

  test("keeps nested-bracket contents as a single argument", () => {
    expect(parseArgList("(f(1, 2), [3])", 0).args).toEqual(["f(1, 2)", "[3]"]);
  });

  test("reports the closing-paren index as the end", () => {
    expect(parseArgList("(a)", 0).end).toBe(2);
  });

  test("drops an empty trailing argument", () => {
    expect(parseArgList("(a, )", 0).args).toEqual(["a"]);
  });

  test("stops cleanly on an unterminated list", () => {
    expect(parseArgList("(a", 0).args).toEqual([]);
  });
});
