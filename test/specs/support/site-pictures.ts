/**
 * A picture the owner uploaded and put in the site's own words. The public
 * pages turn a picture reference into the picture itself; these helpers keep
 * the one picture a story talks about and read it back off the rendered pages.
 */

// jscpd:ignore-start
import {
  imageNamed,
  ownerHasImageInLibrary,
} from "#test/specs/support/images.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

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

/** The owner uploads a picture, kept under the name their text gives it. The
 * library write is the editor stories' helper; the story then keeps the row's
 * own id and filename, and the name their words use. */
export const uploadsSitePicture = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  await ownerHasImageInLibrary(world, name);
  const image = await imageNamed(name);
  world.siteImage = { alt: name, filename: image.filename, id: image.id };
};

/** The page's site footer region, where the footer's own words show. */
export const footerHtml = (html: string): string => {
  const start = html.indexOf('<footer class="site-footer">');
  const end = html.indexOf("</footer>", start);
  return html.slice(start, end);
};
