import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { codeOnlyCorpus } from "#test/scripts/code-quality/code-only.ts";
import {
  importedSymbolsOf,
  isSymbolImported,
  isUsedInSameFile,
} from "#test/scripts/code-quality/detectors.ts";

const mapOf = (entries: [string, string][]): Map<string, string> =>
  new Map(entries);

/** Assert no clause matcher credits `name` in `content`: the single-file
 * matcher and the corpus matcher must agree. */
const expectNotImported = (content: string, name: string): void => {
  expect(isSymbolImported(name, content)).toBe(false);
  expect(importedSymbolsOf(mapOf([["a.ts", content]])).has(name)).toBe(false);
};

describe("the matchers read code, not raw text", () => {
  test("does not count import-shaped text in a line comment", () => {
    expectNotImported(
      '// import { foo } from "./x.ts";\nexport const bar = 1;',
      "foo",
    );
  });

  test("does not count import-shaped text in a JSDoc block", () => {
    const content = [
      "/**",
      " * Loads the module:",
      ' * import { foo } from "./x.ts";',
      " */",
      "export const bar = 1;",
    ].join("\n");
    expectNotImported(content, "foo");
  });

  test("does not count import-shaped text in a string literal", () => {
    expectNotImported("const hint = \"import { foo } from './x.ts'\";", "foo");
  });

  test("does not count import-shaped text in a template literal", () => {
    expectNotImported('const hint = `import { foo } from "./x.ts"`;', "foo");
  });

  test("still detects a lazyExport entry that shares a file with comments", () => {
    const content = [
      "// The route table defers each page's module.",
      'lazyExport(() => import("#routes/foo.ts"), "routeFoo"),',
    ].join("\n");
    expect(isSymbolImported("routeFoo", content)).toBe(true);
    expect(importedSymbolsOf(mapOf([["a.ts", content]])).has("routeFoo")).toBe(
      true,
    );
  });

  test("does not credit a lazyExport shape whose name is not double-quoted", () => {
    expectNotImported(
      "lazyExport(() => import(\"#routes/foo.ts\"), 'routeFoo'),",
      "routeFoo",
    );
  });

  test("does not count a JSDoc link as a same-file usage", () => {
    const content = [
      "/** The reverse of {@link reverseOf}. */",
      "export const reverseOf = (x: string): string => x;",
    ].join("\n");
    expect(isUsedInSameFile("reverseOf", content)).toBe(false);
  });
});

describe("isUsedInSameFile credits the file's own body", () => {
  test("counts a bare reference such as arithmetic", () => {
    const content = [
      "export const DAY_MS = 86_400_000;",
      "export const HOUR_MS = DAY_MS / 24;",
    ].join("\n");
    expect(isUsedInSameFile("DAY_MS", content)).toBe(true);
  });

  test("counts a call inside another export's initializer", () => {
    const content = [
      "export const buildTable = () => [];",
      "export const TABLE = buildTable();",
    ].join("\n");
    expect(isUsedInSameFile("buildTable", content)).toBe(true);
  });

  test("counts a same-file throw site", () => {
    const content = [
      'export const COST_MISMATCH = "cost mismatch";',
      "export const check = (ok: boolean): void => {",
      "  if (!ok) throw new Error(COST_MISMATCH);",
      "};",
    ].join("\n");
    expect(isUsedInSameFile("COST_MISMATCH", content)).toBe(true);
  });

  test("still skips only the line that declares the symbol", () => {
    expect(isUsedInSameFile("foo", "export const foo = 1;")).toBe(false);
    expect(
      isUsedInSameFile("foo", "export const foo = 1;\nexport const foo2 = 2;"),
    ).toBe(false);
  });

  test("counts a use inside a template interpolation", () => {
    const content = [
      "export const escapeIcs = (s: string): string => s;",
      "export const line = (s: string): string => `LOC:${escapeIcs(s)}`;",
    ].join("\n");
    expect(isUsedInSameFile("escapeIcs", content)).toBe(true);
  });

  test("reads past a regex literal that holds quotes", () => {
    const content = [
      "export const extractViewBox = (svg: string): number => 1;",
      'const match = "svg".match(/viewBox="([^"]+)"/);',
      "export const width = () => extractViewBox(match?.input ?? '');",
    ].join("\n");
    expect(isUsedInSameFile("extractViewBox", content)).toBe(true);
  });
});

describe("codeOnlyCorpus", () => {
  test("walks a corpus once and serves repeat queries from the cache", () => {
    const corpus = mapOf([["a.ts", '// import { foo } from "./x.ts";']]);
    expect(codeOnlyCorpus(corpus)).toBe(codeOnlyCorpus(corpus));
  });
});
