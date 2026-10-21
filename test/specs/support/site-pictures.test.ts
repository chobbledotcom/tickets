// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { footerHtml } from "#test/specs/support/site-pictures.ts";

// jscpd:ignore-end

describe("the site picture helpers", () => {
  test("slices out the page's footer region", () => {
    expect(
      footerHtml(
        '<main>words</main><footer class="site-footer"><p>footer words</p></footer>',
      ),
    ).toBe('<footer class="site-footer"><p>footer words</p>');
  });

  test("fails loudly when the page shows no footer", () => {
    expect(() => footerHtml("<main>words</main>")).toThrow(
      "the page renders no site footer",
    );
  });
});
