/**
 * The loader-builder clause shapes the dead-export scanner reads: the prefix
 * declaration picks a remote export as a quoted string after a dynamic
 * import, and that names a production use. Regression tests for the fold
 * from lazyExport tables to the loader builders (#2268).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isSymbolImported } from "#test/scripts/code-quality/detectors.ts";

describe("isSymbolImported over loader builders", () => {
  test("detects a handlerLoader declaration entry by its quoted name", () => {
    expect(
      isSymbolImported(
        "routeFoo",
        'handlerLoader(() => import("#routes/foo.ts"), "routeFoo")',
      ),
    ).toBe(true);
  });

  test("detects a handlerLoader entry split across lines", () => {
    expect(
      isSymbolImported(
        "routeFoo",
        'handlerLoader(\n  () => import("#routes/foo.ts"),\n  "routeFoo",\n)',
      ),
    ).toBe(true);
  });

  test("detects a routesObjectLoader entry by its quoted name", () => {
    expect(
      isSymbolImported(
        "fooRoutes",
        'routesObjectLoader(\n  () => import("#routes/foo.ts"),\n  "fooRoutes",\n)',
      ),
    ).toBe(true);
  });

  test("does not count a builder call without a dynamic import", () => {
    expect(
      isSymbolImported("routeFoo", 'handlerLoader(load, "routeFoo")'),
    ).toBe(false);
  });
});
