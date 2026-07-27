// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  dayLog,
  doorPageHtml,
  otherListing,
  peopleOfferedAtDoor,
  personWithTicket,
  refundTicket,
  showTicketAtDoor,
  ticketOf,
} from "#test/specs/support/door.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** What the door said about the last person the organiser looked at. */
const lastAnswer = (world: TicketsWorld) =>
  requiredWorldValue(world.doorAnswer, "the door's answer");

Given(
  "{word} has a ticket for the {word}",
  function (this: TicketsWorld, who: string, listing: string): Promise<void> {
    return personWithTicket(this, who, listing);
  },
);

Given(
  "{word} has a ticket for {int} places at the {word}",
  function (
    this: TicketsWorld,
    who: string,
    places: number,
    listing: string,
  ): Promise<void> {
    return personWithTicket(this, who, listing, { places });
  },
);

Given(
  "{word} has a ticket for the {word}, which needs ID checked",
  function (this: TicketsWorld, who: string, listing: string): Promise<void> {
    return personWithTicket(this, who, listing, { needsIdChecked: true });
  },
);

Given(
  "the {word} is running its own door",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return otherListing(this, listing);
  },
);

Given(
  "{word}'s {word} ticket has been refunded",
  function (this: TicketsWorld, who: string, listing: string): Promise<void> {
    return refundTicket(this, who, listing);
  },
);

/** The organiser reads one person's ticket at one listing's door, with whatever
 * they decided to do about a ticket the door queried. */
const readTicket = async function (
  this: TicketsWorld,
  who: string,
  listing: string,
  choices: { confirmedTheirId?: boolean; letInAnyway?: boolean } = {},
): Promise<void> {
  this.doorAnswer = await showTicketAtDoor(
    this,
    listing,
    ticketOf(this, who),
    choices,
  );
};

// Cucumber matches an expression whatever keyword the story used, so the
// "Given the organiser reads …" set-up lines run this same definition.
When(
  "the organiser reads {word}'s ticket at the {word} door",
  function (this: TicketsWorld, who: string, listing: string): Promise<void> {
    return readTicket.call(this, who, listing);
  },
);

/** The organiser answers the question the door just asked them. The door has to
 * have asked it: sending an answer to a question that was never put is not
 * something the organiser could do, and would hide a door that stopped
 * querying. */
const answerTheDoor = async function (
  this: TicketsWorld,
  who: string,
  listing: string,
  asked: string,
  choices: { confirmedTheirId?: boolean; letInAnyway?: boolean },
): Promise<void> {
  expect(lastAnswer(this).status).toBe(asked);
  await readTicket.call(this, who, listing, choices);
};

When(
  "the organiser lets {word} in at the {word} door anyway",
  function (this: TicketsWorld, who: string, listing: string): Promise<void> {
    return answerTheDoor.call(this, who, listing, "wrong_listing", {
      letInAnyway: true,
    });
  },
);

When(
  "the organiser confirms {word}'s ID at the {word} door",
  function (this: TicketsWorld, who: string, listing: string): Promise<void> {
    return answerTheDoor.call(this, who, listing, "verify_id", {
      confirmedTheirId: true,
    });
  },
);

Then(
  "the door lets {word} in",
  function (this: TicketsWorld, who: string): void {
    const answer = lastAnswer(this);
    expect(answer.status).toBe("checked_in");
    expect(answer.name).toBe(who);
  },
);

Then(
  "the door says {word} is already in",
  function (this: TicketsWorld, who: string): void {
    const answer = lastAnswer(this);
    expect(answer.status).toBe("already_checked_in");
    expect(answer.name).toBe(who);
  },
);

Then(
  "the door says {word} was refunded",
  function (this: TicketsWorld, who: string): void {
    const answer = lastAnswer(this);
    expect(answer.status).toBe("refunded");
    expect(answer.name).toBe(who);
  },
);

Then(
  "the door says {word} belongs to the {word}",
  function (this: TicketsWorld, who: string, listing: string): void {
    const answer = lastAnswer(this);
    expect(answer.status).toBe("wrong_listing");
    expect(answer.name).toBe(who);
    expect(answer.listingName).toBe(listing);
  },
);

Then(
  "the door asks the organiser to check {word}'s ID",
  function (this: TicketsWorld, who: string): void {
    const answer = lastAnswer(this);
    expect(answer.status).toBe("verify_id");
    expect(answer.name).toBe(who);
  },
);

Then(
  "the door says the ticket covers {int} place(s)",
  function (this: TicketsWorld, places: number): void {
    expect(lastAnswer(this).quantity).toBe(places);
  },
);

Then(
  "the {word}'s record of the day says {word} was checked in",
  async function (
    this: TicketsWorld,
    listing: string,
    who: string,
  ): Promise<void> {
    const written = await dayLog(this, listing);
    expect(written).toContain(who);
    expect(written).toContain(`checked in via scanner for '${listing}'`);
  },
);

Then(
  "the {word} door offers {word} by name",
  async function (
    this: TicketsWorld,
    listing: string,
    who: string,
  ): Promise<void> {
    expect(await peopleOfferedAtDoor(this, listing)).toEqual([
      { name: who, ticket: ticketOf(this, who) },
    ]);
  },
);

Then(
  "the {word} door does not offer {word}",
  async function (
    this: TicketsWorld,
    listing: string,
    who: string,
  ): Promise<void> {
    expect(
      (await peopleOfferedAtDoor(this, listing)).map(({ name }) => name),
    ).not.toContain(who);
    // Their ticket code must be off the page altogether, not merely out of the
    // list — anything left behind is a code the door would still take.
    expect(await doorPageHtml(this, listing)).not.toContain(
      ticketOf(this, who),
    );
  },
);
