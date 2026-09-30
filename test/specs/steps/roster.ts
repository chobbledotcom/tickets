// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { ORGANISER } from "#test/specs/support/browser.ts";
import {
  attendeeListHtml,
  checkinControlLabel,
  movesPartOfAParty,
  type PartDirection,
  partCountOnTheList,
  personWithTicketsForTwoListings,
  pressOnTheAttendeeList,
  rowOnTheAttendeeList,
} from "#test/specs/support/roster.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "{word} has a ticket for the {word} and for the {word}",
  function (
    this: TicketsWorld,
    who: string,
    first: string,
    second: string,
  ): Promise<void> {
    return personWithTicketsForTwoListings(this, who, first, second);
  },
);

When(
  "the organiser presses Check in on the {word}'s attendee list",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return pressOnTheAttendeeList(this, listing, "Check in");
  },
);

When(
  "the organiser presses Check out on the {word}'s attendee list",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return pressOnTheAttendeeList(this, listing, "Check out");
  },
);

Then(
  "the organiser is told {word} was checked in",
  function (this: TicketsWorld, who: string): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(`Checked ${who} in`);
  },
);

Then(
  "the organiser is told {word} was checked out",
  function (this: TicketsWorld, who: string): void {
    expect(whatTheyWereTold(this, ORGANISER)).toContain(`Checked ${who} out`);
  },
);

/** The list is read fresh, so what it offers now is what the organiser sees. */
const expectRowOffers = async (
  world: TicketsWorld,
  listing: string,
  who: string,
  button: string,
): Promise<void> => {
  const html = await attendeeListHtml(world, listing);
  expect(checkinControlLabel(rowOnTheAttendeeList(html, who))).toBe(button);
};

Then(
  "the {word}'s attendee list offers to check {word} out",
  function (this: TicketsWorld, listing: string, who: string): Promise<void> {
    return expectRowOffers(this, listing, who, "Check out");
  },
);

Then(
  "the {word}'s attendee list offers to check {word} in",
  function (this: TicketsWorld, listing: string, who: string): Promise<void> {
    return expectRowOffers(this, listing, who, "Check in");
  },
);

/** One direction's step: the organiser moves that many of a person's
 * tickets through the page behind the list's link. */
const movesPart = (direction: PartDirection) =>
  function (
    this: TicketsWorld,
    tickets: number,
    _who: string,
    listing: string,
  ): Promise<void> {
    return movesPartOfAParty(this, listing, direction, tickets);
  };

When(
  "the organiser checks in {int} of {word}'s tickets from the {word}'s attendee list",
  movesPart("Check in"),
);

When(
  "the organiser checks out {int} of {word}'s tickets from the {word}'s attendee list",
  movesPart("Check out"),
);

Then(
  "the {word}'s attendee list says {int} of {word}'s {int} tickets are in",
  async function (
    this: TicketsWorld,
    listing: string,
    admitted: number,
    who: string,
    total: number,
  ): Promise<void> {
    expect(await partCountOnTheList(this, listing)).toContain(
      `${who}, ${listing}: ${admitted} of ${total} tickets checked in`,
    );
  },
);
