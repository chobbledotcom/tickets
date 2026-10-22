// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  footerHtml,
  sitePictureTag,
  textWithSitePicture,
} from "#test/specs/support/site-pictures.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

describe("the site picture helpers", () => {
  /** A world holding the one picture a story has put in the site's words. */
  const worldWithPicture = (): TicketsWorld =>
    ({
      siteImage: { alt: "A sunny field", filename: "field.png", id: 3 },
    }) as TicketsWorld;

  test("shows the picture at its own address, with the owner's words", () => {
    expect(sitePictureTag(worldWithPicture())).toBe(
      '<img src="/image/field.png" alt="A sunny field">',
    );
  });

  test("places the picture in the owner's text", () => {
    expect(textWithSitePicture(worldWithPicture())).toBe(
      "Have a look. ![A sunny field](img#3)",
    );
  });

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
