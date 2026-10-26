/**
 * A picture the owner uploaded and put in the site's own words. The public
 * pages turn a picture reference into the picture itself; these helpers keep
 * the one picture a story talks about and read it back off the rendered pages.
 */

// jscpd:ignore-start

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { showsPicture } from "#test/specs/support/picture-assertions.ts";
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

/** The reference the owner's text carries for the story's picture, in the
 * short form the editor writes when the owner chooses an image. */
export const sitePictureReference = (world: TicketsWorld): string => {
  const { alt, id } = siteImage(world);
  return `![${alt}](img#${id})`;
};

/** The words the owner types to place the story's picture in a piece of text,
 * with a sentence around it. */
export const textWithSitePicture = (world: TicketsWorld): string =>
  `Have a look. ${sitePictureReference(world)}`;

/** The owner's words with the story's picture placed after them, on its own
 * line, the way the editor writes a page when the owner chooses an image. */
export const wordsWithSitePicture = (
  world: TicketsWorld,
  words: string,
): string => `${words}\n\n${sitePictureReference(world)}`;

/** A page region a story reads: from one opening tag to where the region
 * closes. */
type PageRegion = (html: string) => string;

/** The page region that starts at one opening tag and runs to its closing
 * tag. A region the page does not render is a loud failure. A story that
 * reads a missing region proves nothing. */
const regionHtml = (
  html: string,
  openTag: string,
  closeTag: string,
  region: string,
): string => {
  const start = html.indexOf(openTag);
  if (start === -1) throw new Error(`the page renders no ${region}`);
  const end = html.indexOf(closeTag, start);
  if (end === -1) throw new Error(`the page renders no ${region}`);
  return html.slice(start, end);
};

/** The page's site footer region, where the footer's own words show. */
export const footerHtml = (html: string): string =>
  regionHtml(html, '<footer class="site-footer">', "</footer>", "site footer");

/** The page's own-words region, where the owner's words render. The region
 * runs to the end of the page's <main>, because the site footer renders after
 * it and must never count as the page's own words. */
export const proseHtml = (html: string): string =>
  regionHtml(html, '<div class="prose">', "</main>", "words of its own");

/** The story's picture shows in one region of the page, and no unresolved
 * reference shows anywhere on the page. */
const expectPictureIn =
  (region: PageRegion) =>
  (world: TicketsWorld, html: string): void => {
    showsPicture(region(html), sitePictureTag(world), html);
  };

/** The page's site footer shows the story's picture, and no unresolved
 * reference shows anywhere on the page. */
export const expectFooterPicture = expectPictureIn(footerHtml);

/** The page's own words show the story's picture, and no unresolved
 * reference shows anywhere on the page. */
export const expectProsePicture = expectPictureIn(proseHtml);

/** The page a visitor opened answers 200, says the words the story names, and
 * shows the story's picture in the region the story names — so an error page
 * cannot pass for the page named. */
const readShowsPictureIn =
  (pictureShows: (world: TicketsWorld, html: string) => void) =>
  (world: TicketsWorld, browser: TestBrowser, words: string): void => {
    expect(browser.answered).toBe(200);
    assertStringIncludes(browser.pageText, words);
    pictureShows(world, browser.currentHtml);
  };

/** The page a visitor opened says its own words and shows the story's picture
 * in its site footer, so an error page cannot pass for the page named. */
export const readShowsFooterPicture = readShowsPictureIn(expectFooterPicture);

/** The page a visitor opened says the words the story names and shows the
 * story's picture in the page's own words, so an error page cannot pass for
 * the page named. */
export const readShowsProsePicture = readShowsPictureIn(expectProsePicture);

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
