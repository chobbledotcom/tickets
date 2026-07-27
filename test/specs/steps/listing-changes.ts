// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { addDays } from "#shared/dates.ts";
import {
  stopOpeningOn,
  weekdayOf,
} from "#test/specs/support/listing-changes.ts";
import {
  daysOfferedFor,
  visitorTriesToBook,
} from "#test/specs/support/public-booking.ts";
import {
  dayFromToday,
  guest,
  openStayListing,
  stayListing,
  staysOn,
} from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { offeredDaysOf } from "./stays-booking.ts";

// jscpd:ignore-end

/** The first day of the stay the Scenario booked. */
const stayStart = (world: TicketsWorld): string =>
  requiredWorldValue(world.stayStartsOn, "the stay's first day");

Given(
  "a {word} that takes bookings {int} days ahead, {int} day(s) at a time",
  async function (
    this: TicketsWorld,
    name: string,
    ahead: number,
    days: number,
  ): Promise<void> {
    await openStayListing(this, name, days, 5, { bookAheadDays: ahead });
  },
);

When(
  "the organiser stops opening the {word} on the second day of that stay",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await stopOpeningOn(this, name, weekdayOf(addDays(stayStart(this), 1)));
  },
);

Then(
  "the {word} no longer offers a start day {int} days from now",
  async function (
    this: TicketsWorld,
    name: string,
    startsIn: number,
  ): Promise<void> {
    // A stay reaching a day the listing no longer takes cannot start at all,
    // so the day drops off the chooser the customer is shown.
    expect(await daysOfferedFor(stayListing(this, name))).not.toContain(
      dayFromToday(this, startsIn),
    );
  },
);

Then(
  "the {word} offers fewer days to start on than the {word}",
  function (this: TicketsWorld, fewer: string, more: string): void {
    expect(offeredDaysOf(this, fewer).length).toBeLessThan(
      offeredDaysOf(this, more).length,
    );
  },
);

Then(
  "the {word} still offers some days",
  function (this: TicketsWorld, name: string): void {
    // Fewer must not mean none: a listing whose stays fit the window at all
    // still has to be bookable.
    expect(offeredDaysOf(this, name).length).toBeGreaterThan(0);
  },
);

When(
  "two customers try to book a {word} stay starting in {int} days at once",
  async function (
    this: TicketsWorld,
    name: string,
    startsIn: number,
  ): Promise<void> {
    const listing = stayListing(this, name);
    const day = dayFromToday(this, startsIn);
    // Both press Continue together, so the site has to settle the race itself.
    const attempts = await Promise.all([
      visitorTriesToBook(listing, { ...guest(1), day }),
      visitorTriesToBook(listing, { ...guest(2), day }),
    ]);
    this.raceWinners = attempts.filter(({ wasBooked }) => wasBooked).length;
    this.raceListing = name;
  },
);

Then(
  "only one of them got the stay",
  async function (this: TicketsWorld): Promise<void> {
    expect(requiredWorldValue(this.raceWinners, "who got the stay")).toBe(1);
    // And the listing holds that one stay only — the day never went over.
    const name = requiredWorldValue(this.raceListing, "the listing raced for");
    expect((await staysOn(this, name)).length).toBe(1);
  },
);
