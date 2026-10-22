/**
 * A picture the owner uploaded and put in the site's own words. The public
 * pages turn a picture reference into the picture itself; these helpers keep
 * the one picture a story talks about and read it back off the rendered pages.
 */

// jscpd:ignore-start

import { expect } from "@std/expect";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The picture the story put in the site's words. A story that never uploaded
 * one has nothing to look for, so it says so rather than hunting for a row
 * that does not exist. */
const siteImage = (world: TicketsWorld) =>
  requiredWorldValue(world.siteImage, "the picture the story uploaded");

/** The tag the page shows once the site resolved the reference: the picture
 * at its own address, with the words the owner's text gives it. */
export const sitePictureTag = (world: TicketsWorld): string => {
  const image = siteImage(world);
  return `<img src="/image/${image.filename}" alt="${image.alt}">`;
};

/** The words the owner types to place the story's picture in a piece of text,
 * with a sentence around it. */
export const textWithSitePicture = (world: TicketsWorld): string => {
  const { alt, id } = siteImage(world);
  return `Have a look. ![${alt}](img#${id})`;
};

/** The page's site footer region, where the footer's own words show. */
export const footerHtml = (html: string): string => {
  const start = html.indexOf('<footer class="site-footer">');
  if (start === -1) throw new Error("the page renders no site footer");
  const end = html.indexOf("</footer>", start);
  return html.slice(start, end);
};

/** The story's picture shows inside this page's site footer, and no
 * unresolved reference shows anywhere on the page. */
export const expectFooterPicture = (
  world: TicketsWorld,
  html: string,
): void => {
  expect(footerHtml(html)).toContain(sitePictureTag(world));
  expect(html).not.toContain("img#");
};

/** The page somebody opened shows the story's picture in its site footer,
 * and the site answered it with the status the story expects. */
export const footerShowsPicture = (
  world: TicketsWorld,
  answered: number,
  browser: TestBrowser,
): void => {
  expect(browser.answered).toBe(answered);
  expectFooterPicture(world, browser.currentHtml);
};
