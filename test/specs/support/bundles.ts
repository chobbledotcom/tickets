/**
 * Several things sold together as one bundle. The organiser builds and prices a
 * bundle on the group's own edit form, and a customer buys it from the bundle's
 * own page — so a form or a page that stopped working fails the story rather
 * than being reached around.
 */

import { expect } from "@std/expect";
import { mapNotNullish } from "#fp";
import { getGroupPackagePrices } from "#shared/db/groups.ts";
import type { Group, GroupListing } from "#shared/types.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
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
  ownPrice?: number;
}

/** The bundle a story is talking about. */
const bundleNamed = (world: TicketsWorld, name: string): Group =>
  requiredWorldValue(world.bundles?.get(name), `the ${name} bundle`);

/** Things that exist and belong together, before the organiser has decided
 * they are a bundle at all. */
export const thingsGroupedTogether = async (
  world: TicketsWorld,
  name: string,
  parts: PartOfBundle[],
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
        unitPrice: Math.round((part.ownPrice ?? 0) * 100),
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
): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const part of parts) {
    const box = `package_price_${stayListing(world, part.name).id}`;
    expect(html).toContain(`name="${box}"`);
    values[box] =
      part.bundlePrice === undefined ? "" : part.bundlePrice.toFixed(2);
  }
  return values;
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
 * whether what is inside stays private. Keeps whatever they were told, so a
 * story can read the refusal as well as the success. */
export const organiserSellsAsBundle = async (
  world: TicketsWorld,
  name: string,
  parts: PartOfBundle[],
  options: { keepPartsPrivate?: boolean } = {},
): Promise<string> => {
  const browser = await bundlePage(world, name);
  await browser.submitForm(
    {
      ...bundleForm(world, parts, browser.currentHtml),
      hide_package_listings: options.keepPartsPrivate ? ["1"] : [],
      is_package: ["1"],
    },
    "Save Changes",
  );
  return browser.pageText;
};

/** The organiser stops selling this as a bundle, by clearing the box. */
export const organiserStopsBundling = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  const browser = await bundlePage(world, name);
  await browser.submitForm({ is_package: [] }, "Save Changes");
};

/** The organiser lets people see what is inside again. */
export const organiserRevealsParts = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  const browser = await bundlePage(world, name);
  await browser.submitForm({ hide_package_listings: [] }, "Save Changes");
};

/** Whether the site is still selling this as one bundle. */
export const isStillABundle = async (
  world: TicketsWorld,
  name: string,
): Promise<boolean> => {
  const { groups } = await import("#shared/db/groups.ts");
  const found = await groups.table.findById(bundleNamed(world, name).id);
  return found?.is_package === true;
};

/** What the bundle charges for each part, by the part's name. A part the
 * organiser left blank is absent — the bundle charges the thing's own price. */
export const bundlePrices = async (
  world: TicketsWorld,
  name: string,
): Promise<Map<string, number>> => {
  const rows = await getGroupPackagePrices(bundleNamed(world, name).id);
  const named = new Map<number, string>();
  for (const [thing, listing] of world.stayListings ?? []) {
    named.set(listing.id, thing);
  }
  return new Map(
    mapNotNullish((row: GroupListing) =>
      row.package_price === null
        ? undefined
        : ([
            requiredWorldValue(
              named.get(row.listing_id),
              "a part of the bundle",
            ),
            row.package_price,
          ] as const),
    )(rows),
  );
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
  expect(browser.currentHtml).toContain(`name="package_quantity_${group.id}"`);
  await browser.submitForm(
    {
      email: "buyer@example.com",
      name: "Buyer",
      [`package_quantity_${group.id}`]: "1",
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

/** Whether the bundle is still there at all. */
export const bundleStillExists = async (
  world: TicketsWorld,
  name: string,
): Promise<boolean> => {
  const { groups } = await import("#shared/db/groups.ts");
  return (await groups.table.findById(bundleNamed(world, name).id)) !== null;
};

/** Whether one of the bundle's parts is still for sale on its own account. */
export const partStillExists = async (
  world: TicketsWorld,
  part: string,
): Promise<boolean> => {
  const { getListingWithCount } = await import(
    "#shared/db/listings/records.ts"
  );
  return (await getListingWithCount(stayListing(world, part).id)) !== null;
};
