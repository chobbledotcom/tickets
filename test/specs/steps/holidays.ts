// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { ORGANISER } from "#test/specs/support/browser.ts";
import { ownerLastTold } from "#test/specs/support/buyer-questions.ts";
import { somethingForSale } from "#test/specs/support/editors.ts";
import {
  listingOffersDay,
  organiserAddsHoliday,
  organiserDeletesHoliday,
  sellsDayPlaces,
} from "#test/specs/support/holidays.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import {
  soleBookingOn,
  visitorBooks,
} from "#test/specs/support/public-booking.ts";
import { dayFromToday } from "#test/specs/support/stays.ts";
import {
  keepWhatTheyWereTold,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "the site sells day places at the {word}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return sellsDayPlaces(this, name);
  },
);

Given(
  "the site sells places at the {word}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return somethingForSale(this, name);
  },
);

When(
  "the organiser adds a holiday called {string} on the day {int} days from now",
  function (this: TicketsWorld, name: string, day: number): Promise<void> {
    return organiserAddsHoliday(this, name, dayFromToday(this, day));
  },
);

Given(
  "the organiser has added a holiday called {string} on the day {int} days from now",
  function (this: TicketsWorld, name: string, day: number): Promise<void> {
    return organiserAddsHoliday(this, name, dayFromToday(this, day));
  },
);

Given(
  "the organiser has added a holiday called {string} covering today and the next {int} days",
  function (this: TicketsWorld, name: string, days: number): Promise<void> {
    return organiserAddsHoliday(
      this,
      name,
      dayFromToday(this, 0),
      dayFromToday(this, days),
    );
  },
);

Then(
  "the organiser is told the holiday was created",
  function (this: TicketsWorld): void {
    expect(ownerLastTold(this)).toContain("Holiday created");
  },
);

/** All three day steps ask the listing's page the same question; only the
 * answer they insist on differs. */
const dayOffered = (offered: boolean) =>
  async function (this: TicketsWorld, listing: string, day: number) {
    expect(await listingOffersDay(this, listing, day)).toBe(offered);
  };

Then(
  "the {word} no longer offers the day {int} days from now",
  dayOffered(false),
);

Then("the {word} still offers the day {int} days from now", dayOffered(true));

Then("the {word} offers the day {int} days from now again", dayOffered(true));

When(
  "the organiser deletes the holiday {string} typing its exact name",
  async function (this: TicketsWorld, name: string): Promise<void> {
    keepWhatTheyWereTold(
      this,
      ORGANISER,
      await organiserDeletesHoliday(this, name, name),
    );
  },
);

Then(
  "the organiser is told the holiday was deleted",
  function (this: TicketsWorld): void {
    expect(ownerLastTold(this)).toContain("Holiday deleted");
  },
);

When(
  "a customer books a place at the {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await visitorBooks(this, listingNamed(this, name), {
      email: "gala.goer@example.com",
      who: "Gala Goer",
    });
  },
);

Then(
  "the {word} keeps that booking",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await soleBookingOn(listingNamed(this, name).id)).toBeGreaterThan(0);
  },
);
