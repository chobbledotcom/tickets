/**
 * Things sold alongside something else, and the ones an organiser also sells on
 * their own. A customer only ever meets these through the public pages, so
 * every check here opens a page the way they would.
 */

import { expect } from "@std/expect";
import { groups } from "#shared/db/groups.ts";
import type { Listing } from "#shared/types.ts";
import { rememberStayListing, stayListing } from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { makeParent, ticketPageStatus } from "#test-utils/parents.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

/** Something sold with an add-on, which the organiser may or may not also sell
 * on its own. Both are remembered by the names the story calls them. */
export const sellWithAddOn = async (
  world: TicketsWorld,
  mainThing: string,
  addOn: string,
  onItsOwn: boolean,
): Promise<void> => {
  await enablePublicSite();
  const { parent, children } = await makeParent({
    children: [{ bookableAlone: onItsOwn, name: addOn }],
    parent: { name: mainThing },
  });
  rememberStayListing(world, mainThing, parent);
  rememberStayListing(world, addOn, children[0]!);
};

/** A bundle whose parts the organiser has chosen to keep hidden, holding one
 * part that is nonetheless marked as sellable on its own. */
export const sellHiddenBundle = async (
  world: TicketsWorld,
  bundle: string,
  part: string,
): Promise<void> => {
  await enablePublicSite();
  const group = await createTestGroup({ isPackage: true, name: bundle });
  await groups.table.update(group.id, {
    hidePackageListings: true,
    isPackage: true,
  });
  rememberStayListing(
    world,
    part,
    await createTestListing({
      bookableAlone: true,
      groupId: group.id,
      name: part,
    }),
  );
};

/** The link a customer would follow to book something on its own. */
export const bookingLinkFor = (world: TicketsWorld, name: string): string =>
  `/ticket/${stayListing(world, name).slug}`;

/** A customer opens something's own page and is shown it. Both halves matter:
 * the page has to answer at all, and it has to be the page for this thing
 * rather than some other one that also answered. */
export const expectCustomerCanOpen = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  expect(await ticketPageStatus(stayListing(world, name).slug)).toBe(200);
  const browser = new TestBrowser();
  await browser.visit(bookingLinkFor(world, name));
  expect(browser.pageText).toContain(name);
};

/** There is no page for this thing at all — the site's way of saying it is only
 * ever sold with something else. */
export const expectCustomerCannotOpen = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  expect(await ticketPageStatus(stayListing(world, name).slug)).toBe(404);
};

/** The organiser turns selling-on-its-own on or off, through the listing's own
 * edit form. */
export const sellOnItsOwn = async (
  world: TicketsWorld,
  name: string,
  onItsOwn: boolean,
): Promise<Listing> =>
  updateTestListing(stayListing(world, name).id, { bookableAlone: onItsOwn });

/** Everything the site currently offers for sale, as the customer sees it. */
export const everythingForSale = async (): Promise<TestBrowser> => {
  const browser = new TestBrowser();
  await browser.visit("/listings");
  return browser;
};
