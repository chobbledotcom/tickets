/**
 * Several things sold together as one bundle. The organiser builds and prices a
 * bundle on the group's own edit form, and a customer buys it from the bundle's
 * own page — so a form or a page that stopped working fails the story rather
 * than being reached around.
 */

import { expect } from "@std/expect";
import { getGroupPackagePrices, groups } from "#db/groups.ts";
import { map } from "#fp";
// jscpd:ignore-start
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { toMinorUnits } from "#shared/currency.ts";
import {
  openAdminPage,
  openAsNewcomer,
  opensSalesPagesAt,
  type SavesNamedThingsForm,
  savesServedForm,
} from "#test/specs/support/browser.ts";
import {
  checkboxValueOffered,
  tickedCheckboxes,
} from "#test/specs/support/form-controls/reading.ts";
import {
  expectCanReallySend,
  whyValueCannotBeSent,
} from "#test/specs/support/form-controls/rules.ts";
import {
  listingIdNamed,
  listingNamed,
  rememberListing,
} from "#test/specs/support/listings.ts";
import {
  attachFileTo,
  codeOnTheLinkTheyWereGiven,
  keepsTicketFor,
} from "#test/specs/support/tickets.ts";
import {
  type ActOnOneThing,
  type AsksAboutOneThing,
  asksIfThereIs,
  type ReadAboutOneThing,
  stillThere,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import type { Group, GroupListing } from "#types";
// jscpd:ignore-end

/** One thing inside a bundle, and what the bundle charges for it. */
export interface PartOfBundle {
  /** In pounds and pence, as the organiser types it. Left out keeps the
   * thing's own price. */
  bundlePrice?: number;
  name: string;
}

/** One thing before it is in a bundle, at the price it sells for by itself.
 * That price is what a blank bundle price falls back to, so a story cannot
 * leave it unsaid. */
export interface ThingForSale extends PartOfBundle {
  /** A file the organiser hands out with this part, named as the buyer sees
   * it. Left out, the part hands out nothing. */
  handsOut?: string;
  ownPrice: number;
}

/** The bundle a story is talking about. */
const bundleNamed = (world: TicketsWorld, name: string): Group =>
  world.things.require("bundle", name);

/** Things that exist and belong together, before the organiser has decided
 * they are a bundle at all. */
export const thingsGroupedTogether = async (
  world: TicketsWorld,
  name: string,
  parts: ThingForSale[],
): Promise<void> => {
  await enablePublicSite();
  const group = await createTestGroup({ name });
  world.things.remember("bundle", name, group);
  for (const part of parts) {
    const listing = rememberListing(
      world,
      part.name,
      await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: part.name,
        // The site's own thank-you page: a bundle of one part otherwise falls
        // through to that part's own page and the buyer never reaches a ticket.
        thankYouUrl: "",
        unitPrice: toMinorUnits(part.ownPrice),
      }),
    );
    if (part.handsOut !== undefined) {
      await attachFileTo(listing.id, part.handsOut);
    }
  }
};

/** What the organiser fills in on the bundle's own form. Every part gets a
 * price box, so a box that disappeared would be saved as "no price" without
 * anyone noticing. */
const bundleForm = (
  world: TicketsWorld,
  parts: PartOfBundle[],
  html: string,
): Record<string, string> => {
  const filledIn = Object.fromEntries(
    map((part: PartOfBundle) => {
      const box = `package_price_${listingIdNamed(world, part.name)}`;
      expect(html).toContain(`name="${box}"`);
      return [
        box,
        part.bundlePrice === undefined ? "" : part.bundlePrice.toFixed(2),
      ] as const;
    })(parts),
  );
  expectCanReallySend(html, filledIn);
  return filledIn;
};

/** One of the organiser's own choices on the bundle form, ticked or left clear.
 * The box has to be there, be usable, and start clear: a page that came back
 * already ticked would let the story report that the organiser turned something
 * on when a real click would have turned it off. */
const choiceOnForm = (
  html: string,
  field: string,
  wanted: boolean,
): string[] => {
  const value = checkboxValueOffered(html, field);
  expect(tickedCheckboxes(html, field)).not.toContain(value);
  return wanted ? [value] : [];
};

/** The organiser unticks a box that was ticked. Unticking only means anything
 * if the page had it ticked, so a form that came back already clear fails here
 * rather than the story "changing" something that was never set. */
const boxCleared = (html: string, field: string): string[] => {
  expect(tickedCheckboxes(html, field)).toContain(
    checkboxValueOffered(html, field),
  );
  return [];
};

/** The organiser's own page for one bundle. */
const bundlePage: ReadAboutOneThing<TestBrowser> = async (world, name) =>
  openAdminPage(world, `/admin/groups/${bundleNamed(world, name).id}/edit`);

/** The organiser fills in the bundle's own form and saves it, and is handed
 * back what the site told them — some of these saves are meant to be refused,
 * so the words matter as much as the outcome. */
const saveBundleForm: SavesNamedThingsForm<string> = async (
  world,
  name,
  fillsIn,
) => {
  const browser = await bundlePage(world, name);
  await savesServedForm(browser, fillsIn);
  return browser.pageText;
};

/** Save the bundle's own form and make sure the save really landed. A save
 * that wrote the bundle and then fell over is not an organiser building one,
 * and everything the story checks afterwards would still pass. */
const savesBundleForm = async (
  ...saving: Parameters<typeof saveBundleForm>
): Promise<void> => {
  expect(await saveBundleForm(...saving)).toContain(GROUP_SAVED);
};

/** The organiser turns a group into a bundle, pricing each part, and says
 * whether what is inside stays private. */
export const organiserSellsAsBundle = (
  world: TicketsWorld,
  name: string,
  parts: PartOfBundle[],
  keepPartsPrivate: boolean,
): Promise<void> =>
  savesBundleForm(world, name, (page) => ({
    ...bundleForm(world, parts, page),
    hide_package_listings: choiceOnForm(page, PRIVATE_BOX, keepPartsPrivate),
    is_package: choiceOnForm(page, BUNDLE_BOX, true),
  }));

/** What the site tells an organiser when a group's own form saves, and when a
 * group is deleted. */
export const GROUP_SAVED = "Group updated";
export const GROUP_DELETED = "Group deleted";

const BUNDLE_BOX = "is_package";
const PRIVATE_BOX = "hide_package_listings";

/** The organiser stops selling this as a bundle, by clearing the box. Keeps
 * what they were told, because this is refused for a private bundle. */
export const organiserStopsBundling: ReadAboutOneThing = async (world, name) =>
  saveBundleForm(world, name, (page) => ({
    is_package: boxCleared(page, BUNDLE_BOX),
  }));

/** The organiser lets people see what is inside again. */
export const organiserRevealsParts: ActOnOneThing = (world, name) =>
  savesBundleForm(world, name, (page) => ({
    hide_package_listings: boxCleared(page, PRIVATE_BOX),
  }));

/** The bundle as the site has it now, or nothing if it is gone. */
const storedBundleOrNull = (world: TicketsWorld, name: string) =>
  groups.table.read.one({ id: bundleNamed(world, name).id });

/** Whether the site is still selling this as one bundle. */
export const isStillABundle: AsksAboutOneThing = async (world, name) => {
  // A bundle that vanished is not the same as one that stopped being a bundle,
  // and answering "no" for both would hide a group the site destroyed.
  return stillThere(await storedBundleOrNull(world, name), name).is_package;
};

/** What the bundle charges for one part, or nothing when the organiser set no
 * price of its own for it. A part that is not in the bundle at all is a
 * different thing altogether and throws, so "no price" can never be read from a
 * part the save quietly dropped. */
export const bundleChargeForOrNull = async (
  world: TicketsWorld,
  name: string,
  part: string,
): Promise<number | null> => {
  const wanted = listingIdNamed(world, part);
  const rows = await getGroupPackagePrices(bundleNamed(world, name).id);
  const inBundle = rows.find((row: GroupListing) => row.listing_id === wanted);
  if (!inBundle) throw new Error(`The ${part} is not in the ${name} at all`);
  return inBundle.package_price;
};

/**
 * The page a customer buys a bundle from, opened as anyone would. The slug is
 * kept on the world so an evidence capture can open the same page the story
 * read, and the page text so a story can say what it named.
 */
const openBundlePage = opensSalesPagesAt(
  (world, name) => `/ticket/${bundleNamed(world, name).slug}`,
);

export const customerOpensBundlePage: ReadAboutOneThing<TestBrowser> = async (
  world,
  name,
) => {
  const group = bundleNamed(world, name);
  const browser = await openBundlePage(world, name);
  // The box has to be there and be able to take a one, or the bundle could not
  // be chosen in a real browser however well a crafted send goes through.
  expect(browser.currentHtml).toContain(`name="package_quantity_${group.id}"`);
  world.bundleBookingPage = browser.pageText;
  leaveEvidencePage(world, ["bundle-booking-page"], `/ticket/${group.slug}`);
  return browser;
};

/** A customer buys some of the bundle from its own page, and keeps the code
 * the site gives them under the bundle's name, so the story can read the
 * ticket they end up holding. */
export const customerBuysBundles = async (
  world: TicketsWorld,
  name: string,
  howMany: number,
): Promise<void> => {
  const group = bundleNamed(world, name);
  const browser = await customerOpensBundlePage(world, name);
  const filledIn = {
    email: "buyer@example.com",
    name: "Buyer",
    [`package_quantity_${group.id}`]: String(howMany),
  };
  expectCanReallySend(browser.currentHtml, filledIn);
  await browser.submitForm(filledIn, "Continue");
  keepsTicketFor(world, [name], codeOnTheLinkTheyWereGiven(browser));
};

/** A customer buys one of the bundle — what every story but the one about
 * buying several wants. */
export const customerBuysBundle: ActOnOneThing = (world, name) =>
  customerBuysBundles(world, name, 1);

/** The organiser deletes the bundle, confirming by typing its name. Keeps what
 * they were told, because a refusal is the point of one of these rules. */
export const organiserDeletesBundle: ReadAboutOneThing = async (
  world,
  name,
) => {
  const browser = await openAdminPage(
    world,
    `/admin/groups/${bundleNamed(world, name).id}/delete`,
  );
  const typed = "confirm_identifier";
  expect(whyValueCannotBeSent(browser.currentHtml, typed, name)).toBeNull();
  await browser.submitForm({ [typed]: name }, "Delete Group");
  return browser.pageText;
};

export const bundleStillExists: AsksAboutOneThing =
  asksIfThereIs(storedBundleOrNull);

/** A customer opens one of the bundle's parts on its own. Its page has to
 * answer, be that thing's page, and offer a way to book it — a row left in the
 * database that nobody can reach is not "for sale". */
export const expectPartOnSaleAlone: ActOnOneThing = async (world, part) => {
  const listing = listingNamed(world, part);
  const browser = await openAsNewcomer(`/ticket/${listing.slug}`);
  expect(browser.pageText).toContain(part);
  const box = `quantity_${listing.id}`;
  expect(whyValueCannotBeSent(browser.currentHtml, box, "1")).toBeNull();
};
