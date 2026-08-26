/**
 * The public list of everything the site sells, as somebody who has never been
 * here before reads it.
 *
 * A way in is read off the list's own links, never built from a slug: a thing
 * whose link the list stopped showing is a thing no visitor can reach, however
 * happily its page still answers when asked for directly.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  browserSeenBy,
  CUSTOMER,
  openAsNewcomer,
} from "#test/specs/support/browser.ts";
import { groupNamed } from "#test/specs/support/groups.ts";
import { whatTheCustomerSees } from "#test/specs/support/list-narrowing.ts";
import {
  listingNamed,
  putsPlainThingOnSale,
} from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
// jscpd:ignore-end

/** The address the site sells one named thing from, whether that name belongs
 * to a single thing or to a group of them. */
export const wayIntoNamed = async (
  world: TicketsWorld,
  name: string,
): Promise<string> => {
  const listing = world.things.recall("listing", name);
  return `/ticket/${listing ? listing.slug : (await groupNamed(name)).slug}`;
};

/** Whether the list in front of the customer offers a way into one named
 * thing. */
export const listOffersWayInto = async (
  world: TicketsWorld,
  name: string,
): Promise<boolean> => {
  const wayIn = await wayIntoNamed(world, name);
  return browserSeenBy(world, CUSTOMER).links.some(
    ({ href }) => href === wayIn,
  );
};

/** The list neither leads to this thing nor mentions it. Both matter: a name
 * with no link is a dead end, and a link with no name is a way into something
 * the visitor was never told about. */
export const expectNoWayInto = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  expect(await listOffersWayInto(world, name)).toBe(false);
  expect(whatTheCustomerSees(world)).not.toContain(name);
};

/** The list both names this thing and leads to it. */
export const expectOffered = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  expect(whatTheCustomerSees(world)).toContain(name);
  expect(await listOffersWayInto(world, name)).toBe(true);
};

/** Somebody who was handed a link opens it themselves. Whatever the list shows,
 * the page behind the link is the organiser's promise to the people they gave
 * it to. */
export const openedFromALinkTheyWereGiven = async (
  world: TicketsWorld,
  name: string,
): Promise<string> => {
  const browser = await openAsNewcomer(await wayIntoNamed(world, name));
  return browser.pageText;
};

/** Every word in this order, and none of them missing. Reading the page once
 * and comparing where each lands is what proves an order rather than mere
 * presence. */
const expectInThisOrder = (page: string, words: string[]): void => {
  const found = words.map((word) => {
    const at = page.indexOf(word);
    if (at < 0) throw new Error(`The list never says "${word}"`);
    return at;
  });
  expect(found).toEqual([...found].toSorted((a, b) => a - b));
};

/** The bundles come first, under their own heading and in the order named,
 * and everything else on sale begins below them. */
export const expectBundlesGatheredFirst = (
  world: TicketsWorld,
  first: string,
  second: string,
): void => {
  expectInThisOrder(whatTheCustomerSees(world), [
    t("public.packages"),
    first,
    second,
    t("public.all_bookable_listings"),
  ]);
};

/** This thing sits below the bundles, among everything else on sale. */
export const expectBelowTheBundles = (
  world: TicketsWorld,
  name: string,
): void => {
  expectInThisOrder(whatTheCustomerSees(world), [
    t("public.all_bookable_listings"),
    name,
  ]);
};

/** Something people buy without ever turning up to be let in — a raffle
 * ticket, a donation. */
export const sellsSomethingNobodyAttends = (
  world: TicketsWorld,
  name: string,
): Promise<unknown> =>
  putsPlainThingOnSale(world, name, { purchaseOnly: true });

/** Something on sale that the organiser keeps off the public list. */
export const sellsSomethingQuietly = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  await putsPlainThingOnSale(world, name, { hidden: true });
};

/** One named thing taken off sale. */
export const takeOffSale = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  await deactivateTestListing(listingNamed(world, name).id);
};

/** How a group holds one of its things: on sale as normal, off sale, or full
 * with no room left. */
export type PartState = "full" | "off sale" | "on sale";

/** A group of things, sold as a bundle or not, kept off the list or not, each
 * part in whatever state the story wants it. */
export const groupHolding = async (
  world: TicketsWorld,
  name: string,
  parts: { name: string; state: PartState }[],
  options: {
    asBundle?: boolean;
    describedAs?: string;
    keptOffTheList?: boolean;
  } = {},
): Promise<void> => {
  const group = await createTestGroup({
    description: options.describedAs ?? "",
    hidden: options.keptOffTheList ?? false,
    isPackage: options.asBundle ?? false,
    name,
  });
  for (const part of parts) {
    const listing = await createTestListing({
      groupId: group.id,
      // A part with no room left is full from the moment it is made, which is
      // the state a sold-out bundle part is really in.
      maxAttendees: part.state === "full" ? 0 : 50,
      name: part.name,
    });
    world.things.remember("listing", part.name, listing);
    if (part.state === "off sale") await deactivateTestListing(listing.id);
  }
};

/** The owner gives the site its name, which heads every public page. */
export const siteIsCalled = (title: string): Promise<void> =>
  settings.update.websiteTitle(title);
