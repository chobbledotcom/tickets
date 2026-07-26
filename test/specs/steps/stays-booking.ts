// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { bookingError } from "#shared/booking/form.ts";
import { addDays, formatDateRangeLabel } from "#shared/dates.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import {
  daysOfferedFor,
  visitorBooks,
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
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";

// jscpd:ignore-end

/** The first day of the stay the Scenario booked. */
const stayStart = (world: TicketsWorld): string =>
  requiredWorldValue(world.stayStartsOn, "the stay's first day");

/** The days the page offered when the customer looked. */
const offeredDays = (world: TicketsWorld): string[] =>
  requiredWorldValue(world.daysOffered, "the days the page offered");

/** The day the organiser closed for a holiday. */
const closedDay = (world: TicketsWorld): string =>
  requiredWorldValue(world.closedDayOn, "the closed day");

/** One customer books a stay, and the Scenario remembers it as the stay it is
 * about — so a later step can read it back off the organiser's own pages. */
const bookStay = async (
  world: TicketsWorld,
  name: string,
  startsIn: number,
  order: number,
  places = 1,
  dayCount?: number,
): Promise<void> => {
  world.stayStartsOn = dayFromToday(startsIn);
  await visitorBooks(world, stayListing(world, name), {
    ...guest(order),
    day: world.stayStartsOn,
    places,
    ...(dayCount === undefined ? {} : { dayCount }),
  });
  world.attendeeId = (await staysOn(world, name)).at(-1)?.id;
};

/** A refused attempt keeps what the customer was shown, so the Then can read
 * the reason from the page rather than from the database. */
const tryToBook = async (
  world: TicketsWorld,
  name: string,
  startsIn: number,
  places = 1,
): Promise<void> => {
  const attempt = await visitorTriesToBook(stayListing(world, name), {
    ...guest(9),
    day: dayFromToday(startsIn),
    places,
  });
  world.customerBrowser = attempt.browser;
  world.bookingWasTaken = attempt.wasBooked;
};

Given(
  "a {word} that is booked {int} day(s) at a time, with room for {int} place(s) a day",
  async function (
    this: TicketsWorld,
    name: string,
    days: number,
    placesADay: number,
  ): Promise<void> {
    await openStayListing(this, name, days, placesADay);
  },
);

Given(
  "a customer booked a {word} stay starting in {int} days",
  function (this: TicketsWorld, name: string, startsIn: number): Promise<void> {
    return bookStay(this, name, startsIn, 1);
  },
);

Given(
  "a customer booked {int} {word} places starting in {int} days",
  function (
    this: TicketsWorld,
    places: number,
    name: string,
    startsIn: number,
  ): Promise<void> {
    return bookStay(this, name, startsIn, 1, places);
  },
);

Given(
  "two customers each booked {int} {word} places starting in {int} days",
  async function (
    this: TicketsWorld,
    places: number,
    name: string,
    startsIn: number,
  ): Promise<void> {
    for (const order of [1, 2]) {
      await bookStay(this, name, startsIn, order, places);
    }
  },
);

Given(
  "the organiser closes the day {int} days from now for a holiday",
  async function (this: TicketsWorld, closedIn: number): Promise<void> {
    this.closedDayOn = dayFromToday(closedIn);
    await createTestHoliday({
      endDate: this.closedDayOn,
      name: "Closed for a holiday",
      startDate: this.closedDayOn,
    });
  },
);

When(
  "a customer books a {word} stay starting in {int} days",
  function (this: TicketsWorld, name: string, startsIn: number): Promise<void> {
    return bookStay(this, name, startsIn, 2);
  },
);

When(
  "another customer books {int} {word} places starting in {int} days",
  function (
    this: TicketsWorld,
    places: number,
    name: string,
    startsIn: number,
  ): Promise<void> {
    return bookStay(this, name, startsIn, 2, places);
  },
);

When(
  "another customer tries to book a {word} stay starting in {int} days",
  function (this: TicketsWorld, name: string, startsIn: number): Promise<void> {
    return tryToBook(this, name, startsIn);
  },
);

When(
  "a customer tries to book {int} {word} places starting in {int} days",
  function (
    this: TicketsWorld,
    places: number,
    name: string,
    startsIn: number,
  ): Promise<void> {
    return tryToBook(this, name, startsIn, places);
  },
);

When(
  "a customer looks at the days the {word} offers",
  async function (this: TicketsWorld, name: string): Promise<void> {
    this.daysOffered = await daysOfferedFor(stayListing(this, name));
  },
);

/** What the organiser reads on the booking's own page. The label must name the
 * stay's first and last day, so a stay stored a day short or long fails. */
export const expectStayRunsFor = async (
  world: TicketsWorld,
  days: number,
): Promise<void> => {
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/attendees/${world.attendeeId}`);
  const first = stayStart(world);
  expect(browser.pageText).toContain(
    formatDateRangeLabel(
      `${first}T00:00:00Z`,
      `${addDays(first, days)}T00:00:00Z`,
    ),
  );
};

Then(
  "the organiser sees the stay runs for {int} days",
  function (this: TicketsWorld, days: number): Promise<void> {
    return expectStayRunsFor(this, days);
  },
);

Then(
  "no stay can start on any of those {int} days",
  async function (this: TicketsWorld, days: number): Promise<void> {
    // Every day of the stay is held, so a stay starting on any of them is
    // refused — including the last day, which overlaps by one day only.
    for (let day = 0; day < days; day++) {
      const attempt = await visitorTriesToBook(stayListing(this, "Cabin"), {
        ...guest(4 + day),
        day: addDays(stayStart(this), day),
      });
      expect(attempt.wasBooked).toBe(false);
    }
  },
);

Then(
  "a stay can still start the day after it ends",
  async function (this: TicketsWorld): Promise<void> {
    const listing = stayListing(this, "Cabin");
    const attempt = await visitorTriesToBook(listing, {
      ...guest(3),
      // A stay of N days starting on day 0 ends on day N-1, so day N is free.
      day: addDays(stayStart(this), listing.duration_days),
    });
    expect(attempt.wasBooked).toBe(true);
  },
);

Then(
  "they are told the {word} has no room for those days",
  function (this: TicketsWorld, name: string): void {
    expect(this.bookingWasTaken).toBe(false);
    // The reason the site itself gives for a named listing, so the story cannot
    // pass on some other refusal.
    expect(this.customerBrowser?.pageText).toContain(
      bookingError.withName(name),
    );
  },
);

Then(
  "a {word} stay starting in {int} days can still be booked",
  async function (
    this: TicketsWorld,
    name: string,
    startsIn: number,
  ): Promise<void> {
    const attempt = await visitorTriesToBook(stayListing(this, name), {
      ...guest(8),
      day: dayFromToday(startsIn),
    });
    expect(attempt.wasBooked).toBe(true);
  },
);

Then(
  "the {word} holds {int} stays of {int} places",
  async function (
    this: TicketsWorld,
    name: string,
    stays: number,
    places: number,
  ): Promise<void> {
    const booked = await staysOn(this, name);
    expect(booked.length).toBe(stays);
    expect(booked.map((stay) => stay.quantity)).toEqual(
      Array.from({ length: stays }, () => places),
    );
  },
);

Then(
  "the {word} still holds only the {int} stays it had",
  async function (this: TicketsWorld, name: string, stays: number) {
    expect((await staysOn(this, name)).length).toBe(stays);
  },
);

Then("the closed day is not offered", function (this: TicketsWorld): void {
  expect(offeredDays(this)).not.toContain(closedDay(this));
});

Then(
  "the day {int} days from now is not offered either",
  function (this: TicketsWorld, day: number): void {
    expect(offeredDays(this)).not.toContain(dayFromToday(day));
  },
);

Then(
  "the day {int} days from now is still offered",
  function (this: TicketsWorld, day: number): void {
    expect(offeredDays(this)).toContain(dayFromToday(day));
  },
);
