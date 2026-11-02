/**
 * The import matcher reads the app prefix declaration's loader entries: each
 * names the export it reads as a quoted string after the lazy-import thunk.
 * See `detectors.ts` for the matcher and `code-only.ts` for the pass that keeps
 * the clause through string blanking.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isSymbolImported } from "#test/scripts/code-quality/detectors.ts";

describe("loader clause names", () => {
  test("detects a routeFromModule entry by its quoted name", () => {
    expect(
      isSymbolImported(
        "routeFoo",
        'routeFromModule(() => import("#routes/foo.ts"), "routeFoo"),',
      ),
    ).toBe(true);
  });

  test("detects both quoted handlers of a getPostRoute entry", () => {
    const content =
      'getPostRoute(\n  () => import("#routes/foo.ts"),\n  "handleFooGet",\n  "handleFooPost",\n  "foo",\n),';
    expect(isSymbolImported("handleFooGet", content)).toBe(true);
    expect(isSymbolImported("handleFooPost", content)).toBe(true);
  });

  test("does not credit a getPostRoute path argument as a symbol", () => {
    expect(
      isSymbolImported(
        "foo",
        'getPostRoute(() => import("#routes/x.ts"), "handleGet", "handlePost", "foo"),',
      ),
    ).toBe(false);
  });
});
