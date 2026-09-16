// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { ticketOf } from "#test/specs/support/door.ts";
import {
  groupDoorChecksInAll,
  groupDoorWithTiers,
  peopleOfferedAtGroupDoor,
  personWithMultiTierTicket,
  personWithTierTicket,
  showTicketAtGroupDoor,
} from "#test/specs/support/group-door.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** What the door said about the last person the organiser looked at. */
const lastAnswer = (world: TicketsWorld) =>
  requiredWorldValue(world.doorAnswer, "the door's answer");

Given(
  "a group door for the {word} holds the {word} and {word} tiers",
  function (
    this: TicketsWorld,
    groupName: string,
    firstTier: string,
    secondTier: string,
  ): Promise<void> {
    return groupDoorWithTiers(this, groupName, [firstTier, secondTier]);
  },
);

Given(
  "{word} has a ticket for the {word} tier",
  function (this: TicketsWorld, who: string, tier: string): Promise<void> {
    return personWithTierTicket(this, who, tier);
  },
);

Given(
  "{word} has a ticket for the {word} and {word} tiers",
  function (
    this: TicketsWorld,
    who: string,
    firstTier: string,
    secondTier: string,
  ): Promise<void> {
    return personWithMultiTierTicket(this, who, [firstTier, secondTier]);
  },
);

Given(
  "the {word} door checks in every listing when scanning",
  function (this: TicketsWorld, groupName: string): Promise<void> {
    return groupDoorChecksInAll(this, groupName);
  },
);

/** The organiser reads one person's ticket at a group's door, with whatever
 * they decided to do about a ticket the door queried. */
const readTicket = async function (
  this: TicketsWorld,
  who: string,
  groupName: string,
  choices: { confirmedTheirId?: boolean; letInAnyway?: boolean } = {},
): Promise<void> {
  this.doorAnswer = await showTicketAtGroupDoor(
    this,
    groupName,
    ticketOf(this, who),
    choices,
  );
};

// Cucumber matches an expression whatever keyword the story used, so the
// "Given the organiser reads …" set-up lines run this same definition.
When(
  "the organiser reads {word}'s ticket at the {word} group door",
  function (this: TicketsWorld, who: string, groupName: string): Promise<void> {
    return readTicket.call(this, who, groupName);
  },
);

/** The organiser answers the question the door just asked them, which the
 * door has to have asked before they could. */
When(
  "the organiser lets {word} in at the {word} group door anyway",
  function (this: TicketsWorld, who: string, groupName: string): Promise<void> {
    expect(lastAnswer(this).status).toBe("wrong_listing");
    return readTicket.call(this, who, groupName, { letInAnyway: true });
  },
);

Then(
  "the door says the ticket holds the {word}",
  function (this: TicketsWorld, tier: string): void {
    expect(lastAnswer(this).listingName).toBe(tier);
  },
);

Then(
  "the door says the ticket holds the {word} and the {word}",
  function (this: TicketsWorld, firstTier: string, secondTier: string): void {
    expect(lastAnswer(this).listingName).toBe(`${firstTier}, ${secondTier}`);
  },
);

Then(
  "the {word} group's scanner offers {word} by name",
  async function (
    this: TicketsWorld,
    groupName: string,
    who: string,
  ): Promise<void> {
    expect(await peopleOfferedAtGroupDoor(this, groupName)).toEqual([
      { name: who, ticket: ticketOf(this, who) },
    ]);
  },
);

Then(
  "the {word} group's scanner does not offer {word}",
  async function (
    this: TicketsWorld,
    groupName: string,
    who: string,
  ): Promise<void> {
    expect(
      (await peopleOfferedAtGroupDoor(this, groupName)).map(({ name }) => name),
    ).not.toContain(who);
  },
);
