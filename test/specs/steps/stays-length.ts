// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  visitorBooks,
  visitorTriesToBook,
} from "#test/specs/support/public-booking.ts";
import {
  changeStayLength,
  dayFromToday,
  guest,
  openStayListing,
  rememberStayListing,
  stayListing,
  staysOn,
} from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { expectListingActivityLogContains } from "#test-utils/assertions.ts";
import { twoGroupedListingsBookedOnAdjacentDays } from "#test-utils/db-helpers/grouped-days.ts";
import { expectStayRunsFor } from "./stays-booking.ts";

// jscpd:ignore-end

const FIRST = "Retreat One";
const SECOND = "Retreat Two";

Given(
  "two Retreat listings sharing a limit of {int} places a day",
  async function (this: TicketsWorld, cap: number): Promise<void> {
    this.sharedDayLimit = cap;
  },
);

Given(
  "{int} places are booked on the first for a day, and {int} on the second for the next day",
  async function (
    this: TicketsWorld,
    onFirst: number,
    onSecond: number,
  ): Promise<void> {
    const { group, listingA, listingB } =
      await twoGroupedListingsBookedOnAdjacentDays({
        cap: this.sharedDayLimit ?? 10,
        dateA: dayFromToday(10),
        dateB: dayFromToday(11),
        quantity: onFirst,
        secondQuantity: onSecond,
      });
    rememberStayListing(this, FIRST, listingA);
    rememberStayListing(this, SECOND, listingB);
    this.sharedDayOver = dayFromToday(11);
    this.groupId = group.id;
  },
);

Given(
  "a Retreat where customers pick up to {int} days themselves",
  async function (this: TicketsWorld, upTo: number): Promise<void> {
    await openStayListing(this, "Retreat", upTo, 5, {
      customerPicksDays: true,
    });
  },
);

Given(
  "a customer booked a {int}-day Retreat stay starting in {int} days",
  async function (
    this: TicketsWorld,
    days: number,
    startsIn: number,
  ): Promise<void> {
    this.stayStartsOn = dayFromToday(startsIn);
    await visitorBooks(this, stayListing(this, "Retreat"), {
      ...guest(1),
      day: this.stayStartsOn,
      dayCount: days,
    });
    this.attendeeId = (await staysOn(this, "Retreat")).at(-1)?.id;
  },
);

When(
  "the organiser makes each {word} stay {int} days long",
  function (this: TicketsWorld, name: string, days: number): Promise<void> {
    return changeStayLength(this, name, days);
  },
);

When(
  "the organiser makes each stay on the first listing {int} days long",
  async function (this: TicketsWorld, days: number): Promise<void> {
    this.lengthChangeMessage = await changeStayLength(this, FIRST, days);
  },
);

When(
  "the organiser lowers the longest Retreat stay to {int} days",
  function (this: TicketsWorld, days: number): Promise<void> {
    return changeStayLength(this, "Retreat", days);
  },
);

Then(
  "the organiser sees that stay now runs for {int} days",
  function (this: TicketsWorld, days: number): Promise<void> {
    return expectStayRunsFor(this, days);
  },
);

Then(
  "the organiser sees that stay still runs for {int} days",
  function (this: TicketsWorld, days: number): Promise<void> {
    return expectStayRunsFor(this, days);
  },
);

Then(
  "a {word} stay can no longer start in {int} days",
  async function (
    this: TicketsWorld,
    name: string,
    startsIn: number,
  ): Promise<void> {
    const attempt = await visitorTriesToBook(stayListing(this, name), {
      ...guest(7),
      day: dayFromToday(startsIn),
    });
    expect(attempt.wasBooked).toBe(false);
  },
);

Then(
  "a {word} stay can start in {int} days again",
  async function (
    this: TicketsWorld,
    name: string,
    startsIn: number,
  ): Promise<void> {
    const attempt = await visitorTriesToBook(stayListing(this, name), {
      ...guest(7),
      day: dayFromToday(startsIn),
    });
    expect(attempt.wasBooked).toBe(true);
  },
);

Then(
  "the organiser is warned that the shared day is over its limit",
  function (this: TicketsWorld): void {
    expect(this.lengthChangeMessage).toContain(
      `group capacity exceeded on ${this.sharedDayOver}`,
    );
  },
);

Then(
  "the warning is kept in the listing's history",
  async function (this: TicketsWorld): Promise<void> {
    await expectListingActivityLogContains(
      stayListing(this, FIRST).id,
      `Duration change caused group capacity overflow on ${this.sharedDayOver}`,
    );
  },
);
