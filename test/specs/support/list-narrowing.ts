/**
 * Narrowing a long list of things for sale down to what somebody is looking
 * for. The organiser's half follows the links their own list shows them, one
 * click at a time, so a narrowing the site stopped offering fails the story
 * instead of being reached around with a made-up address.
 */

import { expect } from "@std/expect";
// jscpd:ignore-start
import { LISTING_FILTERS } from "#shared/listing-filter.ts";
import {
  browserSeenBy,
  CUSTOMER,
  ORGANISER,
  openAsNewcomer,
  opensAdminPageAt,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The organiser's own list of everything they sell. */
const THE_LIST = "/admin/";

/** The organiser opens their list. */
export const organiserOpensList = opensAdminPageAt(THE_LIST);

/** Whether somebody is looking at the list right now — either as it comes, or
 * already narrowed. Any other admin page is not the list, however much of the
 * same address it shares. */
const isLookingAtList = (browser: TestBrowser | undefined): boolean =>
  browser?.currentUrl === THE_LIST ||
  (browser?.currentUrl.startsWith(`${THE_LIST}?`) ?? false);

/** The organiser narrows their list, following the link the list offers for it.
 * A second narrowing carries on from the page the first left them on, which is
 * the only way to show that the two hold together — so the list is opened only
 * when they are not already looking at it. */
export const organiserNarrowsList = async (
  world: TicketsWorld,
  to: string,
): Promise<void> => {
  if (!isLookingAtList(world.things.recall("browser", ORGANISER))) {
    await organiserOpensList(world);
  }
  // Throws when the list offers no such link, which is the site saying this
  // narrowing is not on offer at all.
  await browserSeenBy(world, ORGANISER).clickLink(to);
};

/** Whether the list in front of the organiser still offers a way into one
 * thing. Its own page is the only thing on this list that links there, so a
 * link to it is the list really carrying it. */
export const listOffers = (world: TicketsWorld, name: string): boolean => {
  const into = `/admin/listing/${listingIdNamed(world, name)}`;
  return browserSeenBy(world, ORGANISER).links.some(
    ({ href }) => href === into,
  );
};

/** The kinds of thing a list offers to narrow down to, read off the links it
 * shows: a narrowing link is one that leads to a list of one kind, and nothing
 * else on either page does. "All" is left out — other ways of narrowing offer
 * an "All" of their own, and it is the kinds themselves that say whether there
 * is a choice to make here at all. The words on the links are deliberately not
 * read: the list a customer reads is served without the organiser's copy, so
 * looking one up would fail on a page that never had it. */
const kindsOfferedBy = (browser: TestBrowser): string[] =>
  LISTING_FILTERS.filter((kind) => kind !== "all").filter((kind) =>
    browser.links.some(({ href }) => href.includes(`type=${kind}`)),
  );

/** Nobody looking at this list is offered a choice of kind. */
export const expectNoChoiceOfKind = (
  world: TicketsWorld,
  who: string,
): void => {
  expect(kindsOfferedBy(browserSeenBy(world, who))).toEqual([]);
};

/** A customer looks at everything the site has for sale, never having signed
 * in — which is who that list is for. */
export const customerLooksAtEverything = async (
  world: TicketsWorld,
): Promise<void> => {
  rememberBrowser(world, CUSTOMER, await openAsNewcomer("/listings"));
};

/** What the customer is being shown right now. */
export const whatTheCustomerSees = (world: TicketsWorld): string =>
  browserSeenBy(world, CUSTOMER).pageText;
