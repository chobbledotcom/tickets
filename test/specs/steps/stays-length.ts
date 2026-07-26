// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { visitorBooks } from "#test/specs/support/public-booking.ts";
import {
  changeStayLength,
  dayFromToday,
  guest,
  newestStayOn,
  openStayListing,
  rememberStayListing,
  stayListing,
} from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { expectListingActivityLogContains } from "#test-utils/assertions.ts";
import { twoGroupedListingsBookedOnAdjacentDays } from "#test-utils/db-helpers/grouped-days.ts";
import { expectStayCanBeBooked, expectStayRunsFor } from "./stays-booking.ts";

// jscpd:ignore-end

const FIRST = "Retreat One";

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
    const { listingA } = await twoGroupedListingsBookedOnAdjacentDays({
      cap: requiredWorldValue(this.sharedDayLimit, "the shared day limit"),
      dateA: dayFromToday(this, 10),
      dateB: dayFromToday(this, 11),
      quantity: onFirst,
      secondQuantity: onSecond,
    });
    rememberStayListing(this, FIRST, listingA);
    this.sharedDayOver = dayFromToday(this, 11);
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
    this.stayStartsOn = dayFromToday(this, startsIn);
    await visitorBooks(this, stayListing(this, "Retreat"), {
      ...guest(1),
      day: this.stayStartsOn,
      dayCount: days,
    });
    this.attendeeId = await newestStayOn(this, "Retreat");
  },
);

When(
  "the organiser makes each {word} stay {int} day(s) long",
  async function (
    this: TicketsWorld,
    name: string,
    days: number,
  ): Promise<void> {
    await changeStayLength(this, name, days);
  },
);

When(
  "the organiser makes each stay on the first listing {int} days long",
  async function (this: TicketsWorld, days: number): Promise<void> {
    this.newStayLength = days;
    this.lengthChangeMessage = await changeStayLength(this, FIRST, days);
  },
);

When(
  "the organiser lowers the longest Retreat stay to {int} days",
  async function (this: TicketsWorld, days: number): Promise<void> {
    await changeStayLength(this, "Retreat", days);
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
  function (this: TicketsWorld, name: string, startsIn: number): Promise<void> {
    return expectStayCanBeBooked(
      this,
      name,
      dayFromToday(this, startsIn),
      false,
    );
  },
);

Then(
  "a {word} stay can start in {int} days again",
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
    const listing = stayListing(this, FIRST);
    // Both entries matter: the ordinary record of the change every edit gets,
    // and the warning about the day that went over.
    await expectListingActivityLogContains(
      listing.id,
      `Listing '${listing.name}' duration changed to ${requiredWorldValue(
        this.newStayLength,
        "the new stay length",
      )} day(s)`,
    );
    await expectListingActivityLogContains(
      listing.id,
      `Duration change caused group capacity overflow on ${this.sharedDayOver}`,
    );
  },
);
