/**
 * The listing a story is talking about, and the one way a story changes one.
 *
 * A story names its listings ("the Pottery", "the Weekend") and this is where
 * those names are kept and looked up. Every change to a listing goes through
 * its own edit form here, so a form that stopped working, or a save the site
 * quietly refused, fails the story rather than being stepped around.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import type { Listing } from "#shared/types.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

/** Keep a listing under the name the story calls it, so later steps can find
 * it however it was set up. */
export const rememberStayListing = (
  world: TicketsWorld,
  name: string,
  listing: Listing,
): Listing => {
  world.listingIds.set(name, listing.id);
  world.stayListings ??= new Map();
  world.stayListings.set(name, listing);
  return listing;
};

/** The listing a story set up under this name. */
export const stayListing = (world: TicketsWorld, name: string): Listing =>
  requiredWorldValue(world.stayListings?.get(name), `${name} stay listing`);

/** What the site tells somebody when a listing's own form saves. */
export const LISTING_SAVED = "Listing updated";

/** What somebody fills in, worked out from the page they were actually served.
 * Reading the served page is what stops a story sending a value no real
 * browser could have offered. */
export type FillsInListingForm = (
  served: string,
) => Record<string, string | string[]>;

/**
 * Somebody opens a listing's edit form, fills it in from what the page offers,
 * and saves.
 *
 * Being told it saved, and being left back on the listing, are both checked
 * here: a refused save lands on a page that looks much the same, so a story
 * that only read the stored row afterwards would pass just as happily when the
 * site threw the whole edit away.
 */
export const saveListingEdit = async (
  browser: TestBrowser,
  listingId: number,
  fillsIn: FillsInListingForm,
): Promise<void> => {
  await browser.visit(`/admin/listing/${listingId}/edit`);
  await browser.submitForm(fillsIn(browser.currentHtml), "Save Changes");
  expect(browser.containsText(LISTING_SAVED)).toBe(true);
  // Left on the listing they were editing, rather than bounced somewhere else.
  // Some saves land on the listing and some stay on its form, so both count —
  // being sent to a different listing, or off to a list, does not.
  expect(browser.currentUrl.replace(/\/edit$/, "")).toBe(
    `/admin/listing/${listingId}`,
  );
};

/** The organiser ticks or unticks one box on a listing's own edit form, and
 * saves. What each box means is the caller's business; getting the box off the
 * served page, and sending what a real browser would send, is this helper's. */
export const setBoxOnListing = async (
  world: TicketsWorld,
  name: string,
  field: string,
  decide: (served: string) => string[],
): Promise<void> => {
  await organiserSavesListing(world, name, (served) => ({
    [field]: decide(served),
  }));
};

/** The organiser makes a change to one of their listings — the usual way in,
 * since almost every change is one they make while signed in as themselves. */
export const organiserSavesListing = async (
  world: TicketsWorld,
  name: string,
  fillsIn: FillsInListingForm,
): Promise<void> => {
  await saveListingEdit(
    await adminBrowser(world),
    stayListing(world, name).id,
    fillsIn,
  );
};
