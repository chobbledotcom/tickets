/**
 * The images a ticket page's words can name: what the owner's short reference
 * looks like, and what the served page shows once it resolves one. The reads
 * open the real public pages, because the reference is only worth writing if
 * the image arrives where a customer reads.
 */

// jscpd:ignore-start

import { expect } from "@std/expect";
import { openAsNewcomer } from "#test/specs/support/browser.ts";
import { imageNamed } from "#test/specs/support/images.ts";
import {
  listingNamed,
  putsPlainThingOnSale,
} from "#test/specs/support/listings.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import type { Group, Image } from "#types";

// jscpd:ignore-end

/** Beyond any id the fresh scenario database can hand out, so a reference to
 * it can only be one the library cannot answer. */
const NO_SUCH_IMAGE_ID = 999999;

/** The short reference the editor writes when the owner chooses an image. */
export const imageReference = (image: string, id: number): string =>
  `![${image}](img#${id})`;

/** The reference to one image the library holds, by the name the story uses. */
export const referenceToLibraryImage = async (image: string): Promise<string> =>
  imageReference(image, (await imageNamed(image)).id);

/** The reference a story writes when it names no image the library holds. */
export const referenceNoImageAnswers = (image: string): string =>
  imageReference(image, NO_SUCH_IMAGE_ID);

/** Something plain on sale, with the public site on so a visitor can read its
 * page, and the description the story wrote for it. */
export const sellsReadableThing = async (
  world: TicketsWorld,
  name: string,
  description: string,
): Promise<void> => {
  await enablePublicSite();
  await putsPlainThingOnSale(world, name, { description });
};

/** The image tag a resolved reference renders, as the served page carries it.
 * The head's description echoes the raw words, so only this body tag proves
 * the lookup ran: a page whose lookup did not run renders the tag with no
 * source instead. */
export const resolvedImageTag = (image: Image): string =>
  `<img src="/image/${image.filename}" alt="${image.name}">`;

/** The page shows the image itself. */
export const expectShownImage = (html: string, image: Image): void => {
  expect(html).toContain(resolvedImageTag(image));
};

/** The named package's own section on a served page: the fieldset the page
 * renders for it, where its description and each member's row show. */
export const packageSectionHtml = (html: string, group: Group): string => {
  const start = html.indexOf(`data-package-section="${group.id}"`);
  if (start < 0) {
    throw new Error(`the page shows no section for the package ${group.name}`);
  }
  const end = html.indexOf("</fieldset>", start);
  return html.slice(start, end + "</fieldset>".length);
};

/** The package a story set up, by the story's name for it. */
const packageGroupNamed = (world: TicketsWorld, name: string): Group =>
  requiredWorldValue(
    world.things.recall("bundle", name),
    `the package called "${name}"`,
  );

/** The image shows inside the named package's own section on the page that
 * sells it beside one thing on its own — in the package's description, or in
 * one member's row when the story names that member. */
export const expectShownImageInPackageSection = async (
  world: TicketsWorld,
  packageName: string,
  extraName: string,
  image: string,
  memberName?: string,
): Promise<void> => {
  const section = packageSectionHtml(
    (await visitorReadsMixedPage(world, packageName, extraName)).currentHtml,
    packageGroupNamed(world, packageName),
  );
  if (memberName !== undefined) {
    expect(section).toContain(
      `<label>${memberName} <span class="package-member-qty">`,
    );
  }
  expectShownImage(section, await imageNamed(image));
};

/** A visitor reads the shared page the story set up, by the page's name. */
export const visitorReadsSharedPage = (
  world: TicketsWorld,
  name: string,
): Promise<TestBrowser> =>
  openAsNewcomer(
    `/ticket/${
      requiredWorldValue(
        world.things.recall("bundle", name),
        `the shared page called "${name}"`,
      ).slug
    }`,
  );

/** A visitor reads the page that sells a package and one thing on its own
 * together. */
export const visitorReadsMixedPage = (
  world: TicketsWorld,
  packageName: string,
  extraName: string,
): Promise<TestBrowser> => {
  const extra = listingNamed(world, extraName);
  return openAsNewcomer(
    `/ticket/${packageGroupNamed(world, packageName).slug}+${extra.slug}`,
  );
};

/** A visitor reads the plain page that sells two things together, each thing
 * reached by its own slug. */
export const visitorReadsTwoThingsFromOnePage = (
  world: TicketsWorld,
  first: string,
  second: string,
): Promise<TestBrowser> =>
  openAsNewcomer(
    `/ticket/${listingNamed(world, first).slug}+${
      listingNamed(world, second).slug
    }`,
  );
