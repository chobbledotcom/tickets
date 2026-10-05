// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { bookingError } from "#booking/form.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { t } from "#i18n";
import {
  adminBrowser,
  browserSeenBy,
  keepsWhatTheOrganiserSaw,
  ORGANISER,
  openAdminPage,
  openAsNewcomer,
  rememberBrowser,
  savesServedForm,
} from "#test/specs/support/browser.ts";
import {
  attribute,
  boxFor,
  optionsOffered,
} from "#test/specs/support/form-controls/reading.ts";
import { expectCanReallySend } from "#test/specs/support/form-controls/rules.ts";
import {
  listingIdNamed,
  listingNamed,
  putsPlainThingOnSale,
} from "#test/specs/support/listings.ts";
import {
  keepWhatTheyWereTold,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

/** Who the public-rule scenarios follow: a visitor only reading the page, and
 * a buyer sending it. Neither is the organiser, so neither sees their view. */
const VISITOR = "the visitor";
const BUYER = "the buyer";

/** Something on sale whose minimum the story is about. */
const putsOnSaleWithMinimum = (
  world: TicketsWorld,
  name: string,
  alsoSet: Parameters<typeof putsPlainThingOnSale>[2],
): Promise<void> => putsPlainThingOnSale(world, name, alsoSet).then(() => {});

Given(
  "the site sells a {word} selling at most {int} per purchase",
  async function (this: TicketsWorld, name: string, max: number) {
    await putsOnSaleWithMinimum(this, name, { maxQuantity: max });
  },
);

Given(
  "the site sells a {word} selling at least {int} and at most {int} per purchase",
  async function (
    this: TicketsWorld,
    name: string,
    minimum: number,
    max: number,
  ) {
    await putsOnSaleWithMinimum(this, name, {
      maxQuantity: max,
      minimumQuantity: minimum,
    });
  },
);

Given(
  "the site sells a {word} selling at least {int} per purchase with only {int} places left",
  async function (
    this: TicketsWorld,
    name: string,
    minimum: number,
    places: number,
  ) {
    await putsOnSaleWithMinimum(this, name, {
      maxAttendees: places,
      minimumQuantity: minimum,
    });
  },
);

/** The organiser saves the listing's own form carrying only the minimum. What
 * the page is asked for, and what a real browser would send, are both the
 * served form's; only the minimum is typed. What the site said back is kept
 * for the story's Then steps, because a refused save lands on a page that
 * looks much the same as a saved one. */
When(
  "the organiser saves the {word} with a minimum of {int}",
  async function (this: TicketsWorld, name: string, minimum: number) {
    const browser = await adminBrowser(this);
    await browser.visit(`/admin/listing/${listingIdNamed(this, name)}/edit`);
    await savesServedForm(browser, (served) => {
      expectCanReallySend(served, { minimum_quantity: String(minimum) });
      return { minimum_quantity: String(minimum) };
    });
    keepsWhatTheOrganiserSaw(this, browser);
  },
);

/** The minimum the listing's own form now holds, read off the box itself. */
const storedMinimum = async (
  world: TicketsWorld,
  name: string,
): Promise<string | null> => {
  const browser = await openAdminPage(
    world,
    `/admin/listing/${listingIdNamed(world, name)}/edit`,
  );
  const box = boxFor(browser.currentHtml, "minimum_quantity");
  if (!box) {
    throw new Error(`The ${name} edit form offers no minimum box at all`);
  }
  return attribute(box, "value");
};

Then(
  "the {word} sells at least {int} per purchase",
  async function (this: TicketsWorld, name: string, minimum: number) {
    expect(await storedMinimum(this, name)).toBe(String(minimum));
  },
);

Then(
  "the {word} still sells at least {int} per purchase",
  async function (this: TicketsWorld, name: string, minimum: number) {
    expect(await storedMinimum(this, name)).toBe(String(minimum));
  },
);

Then(
  "the organiser is told the minimum must not be more than the maximum",
  function (this: TicketsWorld): void {
    // The site's own words, so a refusal that stopped explaining itself — or
    // stopped happening at all — fails here rather than passing quietly.
    expect(whatTheyWereTold(this, ORGANISER)).toContain(
      t("error.listing_min_quantity_above_max"),
    );
  },
);

/** The booking page as a visitor is served it, kept in their own window for
 * the story's Then steps to read. */
const openTheBookingPage = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  await enablePublicSite();
  const listing = listingNamed(world, name);
  rememberBrowser(
    world,
    VISITOR,
    await openAsNewcomer(`/ticket/${listing.slug}`),
  );
};

/** The quantity choices the visitor's page offers, read from the chooser
 * itself — so a page that stopped rendering it fails the story rather than
 * quietly offering nothing to pick. */
const choicesOnThePage = (world: TicketsWorld, name: string): string[] =>
  optionsOffered(
    browserSeenBy(world, VISITOR).currentHtml,
    `quantity_${listingNamed(world, name).id}`,
  );

When(
  "a visitor opens the {word}'s booking page",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await openTheBookingPage(this, name);
  },
);

Then(
  "the {word} offers none, or any number from {int} to {int}",
  function (this: TicketsWorld, name: string, from: number, to: number): void {
    const choices = choicesOnThePage(this, name);
    // The whole choice set, not a handful of members of it: a 1 or a 2 in
    // among them would be a choice the rule forbids, however many good
    // choices sat beside it.
    expect(choices).toEqual([
      "0",
      ...Array.from({ length: to - from + 1 }, (_, i) => String(from + i)),
    ]);
  },
);

/** Somebody sends the booking form carrying fewer than the minimum. The page
 * itself offers no such choice — that is checked here, not assumed — so this
 * is the stale or tampered send the server-side rule exists for. Everything
 * else the send carries is what the served form really holds, its own fields
 * and token included. */
When(
  "a buyer tries to book {int} of the {word} anyway",
  async function (this: TicketsWorld, places: number, name: string) {
    await enablePublicSite();
    const listing = listingNamed(this, name);
    const browser = await openAsNewcomer(`/ticket/${listing.slug}`);
    const field = `quantity_${listing.id}`;
    const offered = optionsOffered(
      browser.formBodyFor("Continue", ["email", "name", field]),
      field,
    );
    await browser.submitForm(
      {
        email: "buyer@example.com",
        name: "Keen Buyer",
        [field]: String(places),
      },
      "Continue",
    );
    // The send has happened; now the proof it was a stale or tampered one:
    // the page the buyer was served offered no such choice, which is why the
    // server-side rule exists.
    expect(offered).not.toContain(String(places));
    keepWhatTheyWereTold(this, BUYER, browser.pageText);
  },
);

Then(
  "the buyer is told the {word} sells at least {int} tickets per booking",
  function (this: TicketsWorld, name: string, minimum: number): void {
    // The production message, not a copy of its wording, so the two can never
    // drift apart.
    expect(whatTheyWereTold(this, BUYER)).toContain(
      bookingError.minimum(listingNamed(this, name).name, minimum),
    );
  },
);

Then(
  "nobody is booked on the {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    // The refusal has to leave nothing behind: an attendee row written and
    // abandoned would pass any check of the page the buyer was sent back to.
    expect(await getAttendeesRaw(listingNamed(this, name).id)).toEqual([]);
  },
);

Then(
  "the {word} is shown as sold out",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await openTheBookingPage(this, name);
    // One listing's own page says it is full in its own words; the multi-row
    // pages badge each row. Both are the site's own copy, read from the keys.
    expect(browserSeenBy(this, VISITOR).pageText).toContain(
      t("public.ticket.listing_full"),
    );
  },
);

Then(
  "the {word} offers no number of tickets to choose",
  function (this: TicketsWorld, name: string): void {
    const listing = listingNamed(this, name);
    // Sold out is the sold-out row: no chooser at all, not one whose every
    // choice happens to be unusable.
    expect(browserSeenBy(this, VISITOR).currentHtml).not.toContain(
      `name="quantity_${listing.id}"`,
    );
  },
);
