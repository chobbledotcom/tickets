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
import { requireListingWithCount } from "#db/listings/records.ts";
import {
  adminBrowser,
  type FillsInServedForm,
  openAdminPage,
  type SavesNamedThingsForm,
  savesServedForm,
} from "#test/specs/support/browser.ts";
import { requireCheckboxOffered } from "#test/specs/support/form-controls/reading.ts";
import { expectCanReallySend } from "#test/specs/support/form-controls/rules.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import type { Listing } from "#types";
// jscpd:ignore-end

/** Keep a listing under the name the story calls it, so later steps can find
 * it however it was set up. */
export const rememberListing = (
  world: TicketsWorld,
  name: string,
  listing: Listing,
): Listing => world.things.remember("listing", name, listing);

/** The listing a story set up under this name. */
export const listingNamed = (world: TicketsWorld, name: string): Listing =>
  world.things.require("listing", name);

/** Keep the listing with this id, for a story that made one through a form
 * and was handed nothing but its id back. */
export const rememberListingById = async (
  world: TicketsWorld,
  name: string,
  id: number,
): Promise<Listing> =>
  rememberListing(world, name, await requireListingWithCount(id));

/** The id of the listing a story set up under this name. */
export const listingIdNamed = (world: TicketsWorld, name: string): number =>
  listingNamed(world, name).id;

/** Put something on sale and remember it by the story's name for it, curried
 * on how the thing is made — an ordinary listing, or one booked by the day.
 * Every story that sells something goes through one of the two, so the
 * make-and-remember pair lives in one place. */
const putsUpForSale =
  (make: (options: TestListingOverrides) => Promise<Listing>) =>
  async (
    world: TicketsWorld,
    name: string,
    options: TestListingOverrides = {},
  ): Promise<Listing> =>
    rememberListing(world, name, await make({ ...options, name }));

export const putsOnSale = putsUpForSale(createTestListing);
export const putsOnSaleByTheDay = putsUpForSale(createDailyTestListing);

/** A plain thing for sale with room for several places at once, keeping the
 * site's own thank-you page so a booking's outcome can be read. The shape
 * every story's "something to book" takes when the listing itself is not
 * what the story is about. */
const PLAIN_THING: TestListingOverrides = {
  maxAttendees: 10,
  maxQuantity: 5,
  thankYouUrl: "",
};

/** Something plain on sale, remembered by the story's name for it. Anything a
 * story needs on top — a forwarding address, a description, a file to hand
 * out — rides along beside the plain shape rather than in a fixture of its
 * own. */
export const putsPlainThingOnSale = (
  world: TicketsWorld,
  name: string,
  alsoSet: TestListingOverrides = {},
): Promise<Listing> => putsOnSale(world, name, { ...PLAIN_THING, ...alsoSet });

/** Something the site sells at a price, remembered under the name the story
 * calls it. The listing a money story starts from, so its price and its id are
 * in one place rather than set up slightly differently each time. */
export const sellSomethingAt = async (
  world: TicketsWorld,
  name: string,
  price: string,
  options: { canPayMore?: boolean; keepThankYouPage?: boolean } = {},
): Promise<Listing> => {
  const listing = await putsOnSale(world, name, {
    maxAttendees: 50,
    // A listing that lets a customer pay more than it asks needs a ceiling to
    // pay up to, or there is nothing to be generous within.
    ...(options.canPayMore
      ? { canPayMore: true, maxPrice: minorUnits("100.00") }
      : {}),
    // Keeping the site's own thank-you page lets a story read what the customer
    // is shown, rather than being sent off to another site.
    ...(options.keepThankYouPage ? { thankYouUrl: "" } : {}),
    unitPrice: minorUnits(price),
  });
  world.listingId = listing.id;
  return listing;
};

/** Tick one box on a listing's own admin tab and save, checking the site
 * confirms it. Both the questions and the attributes tab work this way. */
export const tickOnListingTab = async (
  world: TicketsWorld,
  listingName: string,
  tab: string,
  field: string,
  boxId: number,
  saidAfter: string,
): Promise<void> => {
  const listing = listingNamed(world, listingName);
  const browser = await openAdminPage(
    world,
    `/admin/listing/${listing.id}/${tab}`,
  );
  requireCheckboxOffered(browser.currentHtml, field, String(boxId));
  await fillInAndSend(browser, { [field]: String(boxId) }, "Save");
  expect(browser.pageText).toContain(saidAfter);
};

/** What the site tells somebody when a listing's own form saves. */
export const LISTING_SAVED = "Listing updated";

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
  fillsIn: FillsInServedForm,
): Promise<void> => {
  await browser.visit(`/admin/listing/${listingId}/edit`);
  await savesServedForm(browser, fillsIn);
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

/** The organiser changes named fields on a listing's own form. The form has
 * to really offer them: a box that is missing, disabled, or fixed at another
 * value means the organiser could not make the change at all, however happily
 * the send is accepted. */
export const organiserSavesFields = <Fields extends Record<string, string>>(
  world: TicketsWorld,
  name: string,
  fields: Fields,
): Promise<void> =>
  organiserSavesListing(world, name, (served) => {
    expectCanReallySend(served, fields);
    return fields;
  });

/** The organiser makes a change to one of their listings — the usual way in,
 * since almost every change is one they make while signed in as themselves. */
export const organiserSavesListing: SavesNamedThingsForm<void> = async (
  world,
  name,
  fillsIn,
) => {
  await saveListingEdit(
    await adminBrowser(world),
    listingIdNamed(world, name),
    fillsIn,
  );
};
