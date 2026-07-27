/**
 * Several things sold together as one bundle. The organiser builds and prices a
 * bundle on the group's own edit form, and a customer buys it from the bundle's
 * own page — so a form or a page that stopped working fails the story rather
 * than being reached around.
 */

import { expect } from "@std/expect";
import { map } from "#fp";
import { toMinorUnits } from "#shared/currency.ts";
import { getGroupPackagePrices, groups } from "#shared/db/groups.ts";
import type { Group, GroupListing } from "#shared/types.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import {
  checkboxValueOffered,
  whyValueCannotBeSent,
} from "#test/specs/support/form-controls.ts";
import { rememberStayListing, stayListing } from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

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
  ownPrice: number;
}

/** The bundle a story is talking about. */
const bundleNamed = (world: TicketsWorld, name: string): Group =>
  requiredWorldValue(world.bundles?.get(name), `the ${name} bundle`);

/** Things that exist and belong together, before the organiser has decided
 * they are a bundle at all. */
export const thingsGroupedTogether = async (
  world: TicketsWorld,
  name: string,
  parts: ThingForSale[],
): Promise<void> => {
  await enablePublicSite();
  const group = await createTestGroup({ name });
  world.bundles ??= new Map();
  world.bundles.set(name, group);
  for (const part of parts) {
    rememberStayListing(
      world,
      part.name,
      await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: part.name,
        unitPrice: toMinorUnits(part.ownPrice),
      }),
    );
  }
};

/** What the organiser fills in on the bundle's own form. Every part gets a
 * price box, so a box that disappeared would be saved as "no price" without
 * anyone noticing. */
const bundleForm = (
  world: TicketsWorld,
  parts: PartOfBundle[],
  html: string,
): Record<string, string> =>
  Object.fromEntries(
    map((part: PartOfBundle) => {
      const box = `package_price_${stayListing(world, part.name).id}`;
      const typed =
        part.bundlePrice === undefined ? "" : part.bundlePrice.toFixed(2);
      expect(html).toContain(`name="${box}"`);
      expect(whyValueCannotBeSent(html, box, typed)).toBeNull();
      return [box, typed] as const;
    })(parts),
  );

/** One of the organiser's own choices on the bundle form, ticked or cleared.
 * The box has to be there and be usable, so a page that stopped offering it
 * fails the story rather than the choice being forced through underneath. */
const choiceOnForm = (
  html: string,
  field: string,
  wanted: boolean,
): string[] => {
  // Read the box either way. Clearing it needs the same working box as ticking
  // it, so a page that stopped offering it fails here rather than the story
  // sending an empty answer nobody could have sent.
  const value = checkboxValueOffered(html, field);
  return wanted ? [value] : [];
};

/** The organiser's own page for one bundle. */
const bundlePage = async (
  world: TicketsWorld,
  name: string,
): Promise<TestBrowser> => {
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/groups/${bundleNamed(world, name).id}/edit`);
  return browser;
};

/** The organiser turns a group into a bundle, pricing each part, and says
 * whether what is inside stays private. */
export const organiserSellsAsBundle = async (
  world: TicketsWorld,
  name: string,
  parts: PartOfBundle[],
  keepPartsPrivate: boolean,
): Promise<void> => {
  const browser = await bundlePage(world, name);
  const page = browser.currentHtml;
  await browser.submitForm(
    {
      ...bundleForm(world, parts, page),
      hide_package_listings: choiceOnForm(page, PRIVATE_BOX, keepPartsPrivate),
      is_package: choiceOnForm(page, BUNDLE_BOX, true),
    },
    "Save Changes",
  );
};

const BUNDLE_BOX = "is_package";
const PRIVATE_BOX = "hide_package_listings";

/** The organiser stops selling this as a bundle, by clearing the box. Keeps
 * what they were told, because this is refused for a private bundle. */
export const organiserStopsBundling = async (
  world: TicketsWorld,
  name: string,
): Promise<string> => {
  const browser = await bundlePage(world, name);
  await browser.submitForm(
    { is_package: choiceOnForm(browser.currentHtml, BUNDLE_BOX, false) },
    "Save Changes",
  );
  return browser.pageText;
};

/** The organiser lets people see what is inside again. */
export const organiserRevealsParts = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  const browser = await bundlePage(world, name);
  await browser.submitForm(
    {
      hide_package_listings: choiceOnForm(
        browser.currentHtml,
        PRIVATE_BOX,
        false,
      ),
    },
    "Save Changes",
  );
};

/** The bundle as the site has it now, or nothing if it is gone. */
const storedBundleOrNull = (world: TicketsWorld, name: string) =>
  groups.table.findById(bundleNamed(world, name).id);

/** Whether the site is still selling this as one bundle. */
export const isStillABundle = async (
  world: TicketsWorld,
  name: string,
): Promise<boolean> => {
  const found = await storedBundleOrNull(world, name);
  // A bundle that vanished is not the same as one that stopped being a bundle,
  // and answering "no" for both would hide a group the site destroyed.
  if (!found) throw new Error(`The ${name} is gone altogether`);
  return found.is_package;
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
  const wanted = stayListing(world, part).id;
  const rows = await getGroupPackagePrices(bundleNamed(world, name).id);
  const inBundle = rows.find((row: GroupListing) => row.listing_id === wanted);
  if (!inBundle) throw new Error(`The ${part} is not in the ${name} at all`);
  return inBundle.package_price;
};

/** A customer buys the bundle from its own page, and keeps the ticket they end
 * up holding so the story can look at it again later. */
export const customerBuysBundle = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  const group = bundleNamed(world, name);
  const browser = new TestBrowser();
  await browser.visit(`/ticket/${group.slug}`);
  // The box has to be there and be able to take a one, or the bundle could not
  // be chosen in a real browser however well a crafted send goes through.
  const wanting = `package_quantity_${group.id}`;
  expect(browser.currentHtml).toContain(`name="${wanting}"`);
  expect(whyValueCannotBeSent(browser.currentHtml, wanting, "1")).toBeNull();
  world.bundleBookingPage = browser.pageText;
  await browser.submitForm(
    {
      email: "buyer@example.com",
      name: "Buyer",
      [wanting]: "1",
    },
    "Continue",
  );
  // Buying leaves them on a page carrying the link to their ticket, which is
  // the only way they can ever reach it again.
  const toTicket = browser.links.find(({ href }) => href.startsWith("/t/"));
  if (!toTicket) throw new Error("They were given no link to their ticket");
  world.bundleTicketPath = toTicket.href;
};

/** What the buyer's own ticket says now, read from the address they were given
 * when they bought it. */
export const buyersTicket = async (world: TicketsWorld): Promise<string> => {
  const browser = new TestBrowser();
  await browser.visit(
    requiredWorldValue(world.bundleTicketPath, "the buyer's ticket"),
  );
  return browser.pageText;
};

/** The organiser deletes the bundle, confirming by typing its name. Keeps what
 * they were told, because a refusal is the point of one of these rules. */
export const organiserDeletesBundle = async (
  world: TicketsWorld,
  name: string,
): Promise<string> => {
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/groups/${bundleNamed(world, name).id}/delete`);
  await browser.submitForm({ confirm_identifier: name }, "Delete Group");
  return browser.pageText;
};

export const bundleStillExists = async (
  world: TicketsWorld,
  name: string,
): Promise<boolean> => (await storedBundleOrNull(world, name)) !== null;

/** A customer opens one of the bundle's parts on its own. Its page has to
 * answer, be that thing's page, and offer a way to book it — a row left in the
 * database that nobody can reach is not "for sale". */
export const expectPartOnSaleAlone = async (
  world: TicketsWorld,
  part: string,
): Promise<void> => {
  const listing = stayListing(world, part);
  const browser = new TestBrowser();
  await browser.visit(`/ticket/${listing.slug}`);
  expect(browser.pageText).toContain(part);
  const box = `quantity_${listing.id}`;
  expect(whyValueCannotBeSent(browser.currentHtml, box, "1")).toBeNull();
};
