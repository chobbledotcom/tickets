// jscpd:ignore-start

import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { attendeesApi } from "#db/attendees/api.ts";
import { queryAll } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import {
  adminBrowser,
  keepsWhatTheOrganiserSaw,
  openAdminPage,
  savesServedForm,
  scenarioBrowser,
} from "#test/specs/support/browser.ts";
import { optionsOffered } from "#test/specs/support/form-controls/reading.ts";
import { expectCanReallySend } from "#test/specs/support/form-controls/rules.ts";
import {
  listingIdNamed,
  listingNamed,
  organiserSavesListing,
} from "#test/specs/support/listings.ts";
import { visitorBooks } from "#test/specs/support/public-booking.ts";
import { dayFromToday, guest } from "#test/specs/support/stays.ts";
import {
  type TicketsWorld,
  whatWasKeptFor,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

const whatWasTold = whatWasKeptFor("told");
const dayKept = whatWasKeptFor("day");

/** The undated booking rows of one listing — the ones a switch has to give a
 * day. Read directly: the story's claim is about the rows, not a page. */
const undatedRowCount = async (listingId: number): Promise<number> => {
  const rows = await queryAll<{ start_at: string | null }>(
    "SELECT start_at FROM listing_attendees WHERE listing_id = ?",
    [listingId],
  );
  return rows.filter((row) => row.start_at === null).length;
};

/** The switch save itself can carry a new room figure, so the same journey
 * covers a listing whose room is changing as it switches. */
const saveSwitchWithRoom = async (
  world: TicketsWorld,
  name: string,
  placesADay: number | null,
): Promise<void> => {
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/listing/${listingIdNamed(world, name)}/edit`);
  await savesServedForm(browser, (served) => {
    const fills: Record<string, string> = { listing_type: "daily" };
    if (placesADay !== null) fills.max_attendees = String(placesADay);
    expectCanReallySend(served, fills);
    return fills;
  });
  keepsWhatTheOrganiserSaw(world, browser);
};

When(
  "the organiser gives the bookings the first day offered",
  async function (this: TicketsWorld): Promise<void> {
    // The organiser is still on the assign page the switch served: read its
    // offered days and send its own form, without navigating anywhere first.
    const browser = scenarioBrowser(this);
    const offered = optionsOffered(
      browser.currentHtml,
      "assign_undated_to",
    ).filter((value) => value !== "");
    expect(offered.length).toBeGreaterThan(0);
    await giveBookingsADay(this, offered[0]!);
  },
);

const giveBookingsADay = async (
  world: TicketsWorld,
  day: string,
): Promise<void> => {
  const browser = scenarioBrowser(world);
  // The save must carry a day the page itself offered: a date that is not
  // among the select's options is one the organiser could never pick.
  const offered = optionsOffered(browser.currentHtml, "assign_undated_to");
  expect(offered).toContain(day);
  expectCanReallySend(
    browser.formBodyFor("Save Changes", ["assign_undated_to"]),
    { assign_undated_to: day },
  );
  await savesServedForm(browser, () => ({ assign_undated_to: day }));
  keepsWhatTheOrganiserSaw(world, browser);
  world.things.remember("day", "the day the bookings were given", day);
};

When(
  "the organiser gives the bookings the day the stay holds",
  async function (this: TicketsWorld): Promise<void> {
    await giveBookingsADay(this, dayFromToday(this, 10));
  },
);

When(
  "the organiser goes back to the {word}'s page without giving a day",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await openAdminPage(this, `/admin/listing/${listingIdNamed(this, name)}`);
  },
);

Then(
  "the organiser is asked to give the {int} bookings a day",
  function (this: TicketsWorld, count: number): void {
    expect(whatWasTold(this, "the organiser")).toContain(
      t("listings_table.switch_daily_undated_heading", { count }),
    );
  },
);

Then(
  "the organiser is told the {word} has no room for the bookings that day",
  function (this: TicketsWorld, name: string): void {
    expect(whatWasTold(this, "the organiser")).toContain(
      t("listings_table.switch_daily_undated_refused", {
        count: 1,
        date: dayFromToday(this, 10),
        name,
      }),
    );
  },
);

Then(
  "the page says no date has room for all {int} bookings",
  function (this: TicketsWorld, count: number): void {
    expect(whatWasTold(this, "the organiser")).toContain(
      t("listings_table.switch_daily_undated_none_fits", { count }),
    );
  },
);

Then(
  "the {word} is booked by the day",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const listing = (await getListingWithCount(listingIdNamed(this, name)))!;
    expect(listing.listing_type).toBe("daily");
  },
);

Then(
  "the {word} is still not booked by the day",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const listing = (await getListingWithCount(listingIdNamed(this, name)))!;
    expect(listing.listing_type).toBe("standard");
  },
);

Then(
  "the {word}'s bookings still have no day",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await undatedRowCount(listingIdNamed(this, name))).toBeGreaterThan(
      0,
    );
  },
);

Then(
  "no {word} place can be booked for that day",
  async function (this: TicketsWorld, name: string): Promise<void> {
    const day = dayKept(this, "the day the bookings were given");
    expect(
      await attendeesApi.hasAvailableSpots(
        listingIdNamed(this, name),
        1,
        day,
        1,
      ),
    ).toBe(false);
  },
);

/** The other journeys' steps that reach back into the listing's own form. */
When(
  "the organiser makes the {word} an ordinary listing again, with room for {int} places",
  async function (
    this: TicketsWorld,
    name: string,
    places: number,
  ): Promise<void> {
    await organiserSavesListing(this, name, (served) => {
      const fills = { listing_type: "standard", max_attendees: String(places) };
      expectCanReallySend(served, fills);
      return fills;
    });
  },
);

When(
  "the organiser puts the {word} on the day calendar, with room for {int} place(s) a day",
  async function (
    this: TicketsWorld,
    name: string,
    placesADay: number,
  ): Promise<void> {
    await saveSwitchWithRoom(this, name, placesADay);
  },
);

When(
  "another customer books a {word} place",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await visitorBooks(this, listingNamed(this, name), guest(3));
  },
);
