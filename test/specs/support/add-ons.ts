/**
 * Things sold alongside something else, and the ones an organiser also sells on
 * their own. A customer only ever meets these through the public pages, so
 * every check here opens a page the way they would.
 */

/** The box on the edit form. Its value is read off the page, not assumed. */
const FIELD = "bookable_alone";

import { expect } from "@std/expect";
import { groups } from "#shared/db/groups.ts";
import {
  checkboxValueOffered,
  tickedCheckboxes,
} from "#test/specs/support/form-controls.ts";
import {
  organiserSavesListing,
  rememberStayListing,
  stayListing,
} from "#test/specs/support/listings.ts";

import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
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
  await expectTicketPageAnswers(200)(world, name);
  const browser = new TestBrowser();
  await browser.visit(bookingLinkFor(world, name));
  expect(browser.pageText).toContain(name);
};

/** What the site answers when a customer asks for this thing's own page. */
const expectTicketPageAnswers =
  (answer: number) =>
  async (world: TicketsWorld, name: string): Promise<void> => {
    expect(await ticketPageStatus(stayListing(world, name).slug)).toBe(answer);
  };

/** There is no page for this thing at all — the site's way of saying it is only
 * ever sold with something else. */
export const expectCustomerCannotOpen = expectTicketPageAnswers(404);

/** The organiser turns selling-on-its-own on or off, by ticking or unticking
 * the box on the listing's own edit form. The box has to be there and be
 * usable, so a page that stops offering it fails the story rather than the
 * change being forced through underneath. */
export const sellOnItsOwn = async (
  world: TicketsWorld,
  name: string,
  onItsOwn: boolean,
): Promise<void> => {
  await organiserSavesListing(world, name, (served) => {
    // Send whatever the page's own box sends, rather than a value this file
    // believes in: a box rewritten to carry something else must fail the
    // story.
    const ticked = checkboxValueOffered(served, FIELD);
    expect(tickedCheckboxes(served, FIELD)).toEqual(onItsOwn ? [] : [ticked]);
    // Unticking a box sends nothing at all for it, which is what a real
    // browser does.
    return { [FIELD]: onItsOwn ? [ticked] : [] };
  });
};

/** Whether the Chair's own booking page still offers the Cover with it. */
export const bookingPageFor = async (
  world: TicketsWorld,
  name: string,
): Promise<TestBrowser> => {
  const browser = new TestBrowser();
  await browser.visit(bookingLinkFor(world, name));
  return browser;
};

/** Everything the site currently offers for sale, as the customer sees it. */
export const everythingForSale = async (): Promise<TestBrowser> => {
  const browser = new TestBrowser();
  await browser.visit("/listings");
  return browser;
};
