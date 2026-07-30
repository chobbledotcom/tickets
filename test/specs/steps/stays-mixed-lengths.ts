/**
 * Stays whose customers pick their own length, meeting each other on the
 * calendar. The listing here is always a Retreat where customers choose how
 * many days they want, so short and long stays can want the same day.
 */

// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import {
  dayFromToday,
  guest,
  openStayListing,
} from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { expectStayCanBeBooked, tryToBook } from "./stays-booking.ts";

// jscpd:ignore-end

Given(
  "a Retreat where customers pick up to {int} days themselves, with room for {int} place(s) a day",
  async function (
    this: TicketsWorld,
    upTo: number,
    placesADay: number,
  ): Promise<void> {
    await openStayListing(this, "Retreat", upTo, placesADay, {
      customerPicksDays: true,
    });
  },
);

When(
  "another customer tries to book a {int}-day {word} stay starting in {int} days",
  function (
    this: TicketsWorld,
    dayCount: number,
    name: string,
    startsIn: number,
  ): Promise<void> {
    return tryToBook(this, name, startsIn, 1, dayCount);
  },
);

Then(
  "a {int}-day {word} stay starting in {int} days can still be booked",
  function (
    this: TicketsWorld,
    dayCount: number,
    name: string,
    startsIn: number,
  ): Promise<void> {
    return expectStayCanBeBooked(
      this,
      name,
      dayFromToday(this, startsIn),
      true,
      // Somebody new for each day probed, so two probes never share a person.
      guest(20 + startsIn),
      dayCount,
    );
  },
);
