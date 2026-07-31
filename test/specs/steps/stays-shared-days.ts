// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  browserSeenBy,
  CUSTOMER,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import {
  visitorBooks,
  visitorTriesToBook,
  visitorTriesToOrder,
} from "#test/specs/support/public-booking.ts";
import {
  dayFromToday,
  guest,
  openStayListing,
  staysOn,
} from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";

// jscpd:ignore-end

/** Two listings that share one day limit, each with its own stay length. The
 * group's own page is where a customer books both at once. */
const shareADayLimit = async (
  world: TicketsWorld,
  cap: number,
  listings: Array<{ days: number; name: string }>,
): Promise<void> => {
  const group = await createTestGroup({
    maxAttendees: cap,
    name: "Shared Days",
    slug: "shared-days",
  });
  for (const { days, name } of listings) {
    // Each listing has room of its own to spare, so the only limit in play is
    // the one they share.
    await openStayListing(world, name, days, 100, { groupId: group.id });
  }
  world.groupSlug = group.slug;
};

Given(
  "a Saturday and a Weekend listing sharing {int} places a day",
  function (this: TicketsWorld, cap: number): Promise<void> {
    return shareADayLimit(this, cap, [
      { days: 1, name: "Saturday" },
      { days: 2, name: "Weekend" },
    ]);
  },
);

Given(
  "a Short and a Long listing sharing {int} places a day",
  function (this: TicketsWorld, cap: number): Promise<void> {
    return shareADayLimit(this, cap, [
      { days: 2, name: "Short" },
      { days: 4, name: "Long" },
    ]);
  },
);

/** Places booked on one listing, starting on a day counted from today. Each
 * booking is somebody different, so two are never taken for one person. */
const bookPlaces = async (
  world: TicketsWorld,
  name: string,
  places: number,
  startsIn: number,
  order: number,
): Promise<void> => {
  await visitorBooks(world, listingNamed(world, name), {
    ...guest(order),
    day: dayFromToday(world, startsIn),
    places,
  });
};

Given(
  "{int} Saturday places and {int} Weekend places are booked starting in {int} days",
  async function (
    this: TicketsWorld,
    onSaturday: number,
    onWeekend: number,
    startsIn: number,
  ): Promise<void> {
    await bookPlaces(this, "Saturday", onSaturday, startsIn, 1);
    await bookPlaces(this, "Weekend", onWeekend, startsIn, 2);
  },
);

Given(
  "{int} {word} places are booked starting in {int} days",
  function (
    this: TicketsWorld,
    places: number,
    name: string,
    startsIn: number,
  ): Promise<void> {
    return bookPlaces(this, name, places, startsIn, 1);
  },
);

When(
  "a customer tries to book {int} more Saturday place starting in {int} days",
  async function (
    this: TicketsWorld,
    places: number,
    startsIn: number,
  ): Promise<void> {
    const attempt = await visitorTriesToBook(listingNamed(this, "Saturday"), {
      ...guest(3),
      day: dayFromToday(this, startsIn),
      places,
    });
    rememberBrowser(this, CUSTOMER, attempt.browser);
    this.bookingWasTaken = attempt.wasBooked;
  },
);

When(
  "a customer books {int} Weekend places starting in {int} days",
  function (
    this: TicketsWorld,
    places: number,
    startsIn: number,
  ): Promise<void> {
    return bookPlaces(this, "Weekend", places, startsIn, 4);
  },
);

When(
  "a customer tries to book {int} Short places and {int} Long places in one order",
  async function (
    this: TicketsWorld,
    onShort: number,
    onLong: number,
  ): Promise<void> {
    // One order over the group's own page, which offers a quantity per listing —
    // exactly how a customer books two listings at once. It goes through the
    // same visitor mechanism as a single listing, so every control it posts is
    // checked against the served page.
    const slug = requiredWorldValue(this.groupSlug, "the group's page");
    const attempt = await visitorTriesToOrder(
      `/ticket/${slug}`,
      [
        { listing: listingNamed(this, "Short"), places: onShort },
        { listing: listingNamed(this, "Long"), places: onLong },
      ],
      { ...guest(5), day: dayFromToday(this, 10) },
    );
    rememberBrowser(this, CUSTOMER, attempt.browser);
    this.bookingWasTaken = attempt.wasBooked;
  },
);

Then(
  "the order is refused and nothing is booked",
  async function (this: TicketsWorld): Promise<void> {
    expect(this.bookingWasTaken).toBe(false);
    // Refused for want of room, not for some unrelated reason.
    expect(browserSeenBy(this, CUSTOMER).pageText).toContain(
      "enough spots available",
    );
    // Neither half of the order may be taken — a partly-booked order would
    // leave the customer paying for a stay they cannot use.
    expect((await staysOn(this, "Short")).length).toBe(0);
    expect((await staysOn(this, "Long")).length).toBe(0);
  },
);

Then(
  "the {word} holds no stays at all",
  async function (this: TicketsWorld, name: string): Promise<void> {
    // A refused booking must leave nothing behind, or the day it was refused
    // for would quietly lose room to a stay nobody can use.
    expect((await staysOn(this, name)).length).toBe(0);
  },
);
