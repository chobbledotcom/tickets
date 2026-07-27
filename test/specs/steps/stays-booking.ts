// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { addDays, formatDateRangeLabel } from "#shared/dates.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import {
  daysOfferedFor,
  expectRefusedForWantOfRoom,
  visitorBooks,
  visitorTriesToBook,
} from "#test/specs/support/public-booking.ts";
import {
  dayFromToday,
  guest,
  newestStayOn,
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

/** The days a listing's page offered when the customer looked at it. */
export const offeredDaysOf = (world: TicketsWorld, name: string): string[] =>
  requiredWorldValue(
    world.daysOffered?.get(name),
    `the days the ${name} page offered`,
  );

/** The days the page offered the last time a customer looked. */
const offeredDays = (world: TicketsWorld): string[] =>
  offeredDaysOf(
    world,
    requiredWorldValue(world.daysOfferedLastLook, "the listing looked at"),
  );

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
  world.stayStartsOn = dayFromToday(world, startsIn);
  await visitorBooks(world, stayListing(world, name), {
    ...guest(order),
    day: world.stayStartsOn,
    places,
    ...(dayCount === undefined ? {} : { dayCount }),
  });
  world.attendeeId = await newestStayOn(world, name);
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
    day: dayFromToday(world, startsIn),
    places,
  });
  world.customerBrowser = attempt.browser;
  world.bookingWasTaken = attempt.wasBooked;
};

/** Whether a stay starting on a day can actually be booked. The one check
 * behind every "can" and "cannot" step, so the two can never drift apart. */
export const expectStayCanBeBooked = async (
  world: TicketsWorld,
  name: string,
  day: string,
  expected: boolean,
  who = guest(8),
): Promise<void> => {
  const attempt = await visitorTriesToBook(stayListing(world, name), {
    ...who,
    day,
  });
  if (expected) {
    expect(attempt.wasBooked).toBe(true);
    return;
  }
  // A refusal has to be for want of room: any other error would otherwise
  // count as the days being held.
  expectRefusedForWantOfRoom(attempt, name);
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
    this.closedDayOn = dayFromToday(this, closedIn);
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
    this.daysOffered ??= new Map();
    this.daysOffered.set(name, await daysOfferedFor(stayListing(this, name)));
    this.daysOfferedLastLook = name;
  },
);

/** How long the stay runs, checked against the story's own days as well as the
 * page. The label alone would not do: it is built by the same helper the page
 * renders with, so a miscalculated range would match itself. */
export const expectStayRunsFor = async (
  world: TicketsWorld,
  days: number,
): Promise<void> => {
  const first = stayStart(world);
  const dayAfterTheLast = addDays(first, days);
  const bookingId = requiredWorldValue(world.attendeeId, "the booking");
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/attendees/${bookingId}`);
  const stored = await getAttendeeRaw(bookingId);
  if (!stored) throw new Error(`Booking ${bookingId} has gone`);
  expect(stored.date).toBe(first);
  // The site stores the day after the last day held.
  expect(stored.end_date).toBe(dayAfterTheLast);
  expect(browser.pageText).toContain(
    formatDateRangeLabel(`${first}T00:00:00Z`, `${dayAfterTheLast}T00:00:00Z`),
  );
};

Then(
  "the organiser sees the stay runs for {int} days",
  function (this: TicketsWorld, days: number): Promise<void> {
    return expectStayRunsFor(this, days);
  },
);

Then(
  "no {word} stay can start on any of those {int} days",
  async function (this: TicketsWorld, name: string, days: number) {
    // Every day of the stay is held, so a stay starting on any of them is
    // refused — including the last day, which overlaps by one day only.
    for (let day = 0; day < days; day++) {
      await expectStayCanBeBooked(
        this,
        name,
        addDays(stayStart(this), day),
        false,
        guest(4 + day),
      );
    }
  },
);

Then(
  "a {word} stay can still start the day after it ends",
  function (this: TicketsWorld, name: string): Promise<void> {
    // A stay of N days starting on day 0 ends on day N-1, so day N is free.
    const day = addDays(stayStart(this), stayListing(this, name).duration_days);
    return expectStayCanBeBooked(this, name, day, true, guest(3));
  },
);

Then(
  "they are told the {word} has no room for those days",
  function (this: TicketsWorld, name: string): void {
    expectRefusedForWantOfRoom(
      {
        browser: requiredWorldValue(this.customerBrowser, "the page shown"),
        wasBooked: this.bookingWasTaken === true,
      },
      name,
    );
  },
);

Then(
  "a {word} stay starting in {int} days can still be booked",
  function (this: TicketsWorld, name: string, startsIn: number): Promise<void> {
    return expectStayCanBeBooked(
      this,
      name,
      dayFromToday(this, startsIn),
      true,
    );
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
    expect(offeredDays(this)).not.toContain(dayFromToday(this, day));
  },
);

Then(
  "the day {int} days from now is still offered",
  function (this: TicketsWorld, day: number): void {
    expect(offeredDays(this)).toContain(dayFromToday(this, day));
  },
);
