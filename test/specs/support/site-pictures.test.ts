// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectFooterPicture,
  footerHtml,
  footerShowsPicture,
  sitePictureTag,
  textWithSitePicture,
} from "#test/specs/support/site-pictures.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

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

  test("reads the story's picture inside the page's footer region", () => {
    expect(() =>
      expectFooterPicture(
        worldWithPicture(),
        '<main>words</main><footer class="site-footer">' +
          '<p>Come along.</p><img src="/image/field.png" alt="A sunny field"></footer>',
      ),
    ).not.toThrow();
  });

  test("says so when the footer shows no picture", () => {
    expect(() =>
      expectFooterPicture(
        worldWithPicture(),
        '<footer class="site-footer"><p>Come along.</p></footer>',
      ),
    ).toThrow();
  });

  test("says so when a reference is left unresolved anywhere on the page", () => {
    expect(() =>
      expectFooterPicture(
        worldWithPicture(),
        '<footer class="site-footer"><img src="/image/field.png" alt="A sunny field"></footer>' +
          "<p>Still shows img#3.</p>",
      ),
    ).toThrow();
  });

  /** A browser that opened a page the site answered with this status, whose
   * page shows this HTML. */
  const answeredBrowser = (answered: number, html: string): TestBrowser => {
    const browser = new TestBrowser();
    browser.answered = answered;
    browser.currentHtml = html;
    return browser;
  };

  /** The read refuses a page that does not show the story's picture the way
   * the story expects: the same refusal the stories see. */
  const expectReadToThrow = (browser: TestBrowser): void => {
    expect(() =>
      footerShowsPicture(worldWithPicture(), 200, browser),
    ).toThrow();
  };

  test("passes for a page the site answered with the status the story expects", () => {
    expect(() =>
      footerShowsPicture(
        worldWithPicture(),
        200,
        answeredBrowser(
          200,
          '<main>words</main><footer class="site-footer">' +
            '<img src="/image/field.png" alt="A sunny field"></footer>',
        ),
      ),
    ).not.toThrow();
  });

  test("says so when the site answered with another status", () => {
    expectReadToThrow(
      answeredBrowser(
        500,
        '<footer class="site-footer"><img src="/image/field.png" alt="A sunny field"></footer>',
      ),
    );
  });

  test("says so when the answered page's footer shows no picture", () => {
    expectReadToThrow(
      answeredBrowser(
        200,
        '<footer class="site-footer"><p>Come along.</p></footer>',
      ),
    );
  });
});
