/**
 * Things sold alongside something else, and the ones an organiser also sells on
 * their own. A customer only ever meets these through the public pages, so
 * every check here opens a page the way they would.
 */

/** The box on the edit form. Its value is read off the page, not assumed. */
const FIELD = "bookable_alone";

import { expect } from "@std/expect";
import { groups } from "#shared/db/groups.ts";
// jscpd:ignore-start
import {
  type OpensASalesPage,
  openAsNewcomer,
  opensSalesPagesAt,
} from "#test/specs/support/browser.ts";
import {
  checkboxValueOffered,
  tickedCheckboxes,
} from "#test/specs/support/form-controls.ts";
import {
  listingNamed,
  rememberListing,
  setBoxOnListing,
} from "#test/specs/support/listings.ts";

import type {
  ActOnOneThing,
  ChangeOneThing,
  TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { makeParent, ticketPageStatus } from "#test-utils/parents.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

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
  rememberListing(world, mainThing, parent);
  rememberListing(world, addOn, children[0]!);
};

/** A bundle whose parts the organiser has chosen to keep hidden, holding one
 * part that is nonetheless marked as sellable on its own. */
export const sellHiddenBundle: ChangeOneThing<string> = async (
  world,
  bundle,
  part,
) => {
  await enablePublicSite();
  const group = await createTestGroup({ isPackage: true, name: bundle });
  await groups.table.update(group.id, {
    hidePackageListings: true,
    isPackage: true,
  });
  rememberListing(
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
  `/ticket/${listingNamed(world, name).slug}`;

/** A customer opens something's own page and is shown it. Both halves matter:
 * the page has to answer at all, and it has to be the page for this thing
 * rather than some other one that also answered. */
export const expectCustomerCanOpen: ActOnOneThing = async (world, name) => {
  await expectTicketPageAnswers(200)(world, name);
  const browser = await openAsNewcomer(bookingLinkFor(world, name));
  expect(browser.pageText).toContain(name);
};

/** What the site answers when a customer asks for this thing's own page. */
const expectTicketPageAnswers =
  (answer: number) =>
  async (world: TicketsWorld, name: string): Promise<void> => {
    expect(await ticketPageStatus(listingNamed(world, name).slug)).toBe(answer);
  };

/** There is no page for this thing at all — the site's way of saying it is only
 * ever sold with something else. */
export const expectCustomerCannotOpen: ActOnOneThing =
  expectTicketPageAnswers(404);

/** The organiser turns selling-on-its-own on or off, by ticking or unticking
 * the box on the listing's own edit form. The box has to be there and be
 * usable, so a page that stops offering it fails the story rather than the
 * change being forced through underneath. */
export const sellOnItsOwn: ChangeOneThing<boolean> = async (
  world,
  name,
  onItsOwn,
) => {
  await setBoxOnListing(world, name, FIELD, (served) => {
    // Send whatever the page's own box sends, rather than a value this file
    // believes in: a box rewritten to carry something else must fail the story.
    const ticked = checkboxValueOffered(served, FIELD);
    expect(tickedCheckboxes(served, FIELD)).toEqual(onItsOwn ? [] : [ticked]);
    // Unticking a box sends nothing at all for it, which is what a real browser
    // does.
    return onItsOwn ? [ticked] : [];
  });
};

/** Whether the Chair's own booking page still offers the Cover with it. */
export const bookingPageFor: OpensASalesPage =
  opensSalesPagesAt(bookingLinkFor);

/** Everything the site currently offers for sale, as the customer sees it. */
export const everythingForSale = async (): Promise<TestBrowser> => {
  const browser = await openAsNewcomer("/listings");
  return browser;
};
