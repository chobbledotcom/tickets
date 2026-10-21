// jscpd:ignore-start

import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
// jscpd:ignore-end

import { openAdminPage } from "#test/specs/support/browser.ts";
import {
  deliverAtGroupDoor,
  deliverAtListingDoor,
  deliverSavedFromAnotherDoor,
  deliverUnknownCode,
  expectSavedCodesFor,
  expectSavedList,
  expectSavedListEmpty,
  listingCacheName,
  placesAdmittedFor,
  redeliverAtGroupDoor,
  redeliverAtListingDoor,
  saveGroupDoorCodes,
  saveListingDoorCodes,
  trySavingListingDoorCodes,
} from "#test/specs/support/door-codes.ts";
import { editorBrowser } from "#test/specs/support/editors.ts";
import { groupCacheName } from "#test/specs/support/group-door.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

/** What the door said about the last saved check-in it delivered. */
const savedAnswer = (world: TicketsWorld) =>
  requiredWorldValue(world.doorAnswer, "the saved check-in's answer");

/** No ticket the story holds appears in the saved list in any readable
 * form. */
const expectNoTicketCodesIn = (world: TicketsWorld, door: string): void =>
  expectSavedList(world, door, (saved) => {
    for (const name of world.things.names("ticket")) {
      expect(saved.body).not.toContain(world.things.require("ticket", name));
    }
  });

/** The saved list's whole body is the sorted one-way codes and nothing
 * else, so no guest name or address can hide anywhere in it. */
const expectSavedListNamesNobody = (world: TicketsWorld, door: string): void =>
  expectSavedList(world, door, (saved) =>
    expect(saved.body).toMatch(
      /^\{"hashes":\["[0-9a-f]{64}"(?:,"[0-9a-f]{64}")*\]\}$/,
    ),
  );

When(
  "the {word} door saves its tickets for offline reading",
  async function (this: TicketsWorld, listing: string): Promise<void> {
    await saveListingDoorCodes(this, listing);
  },
);

When(
  "the {word} group door saves its tickets for offline reading",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    await saveGroupDoorCodes(this, groupName);
  },
);

When(
  "{word} asks the {word} door to save its tickets for offline reading",
  async function (
    this: TicketsWorld,
    _who: string,
    listing: string,
  ): Promise<void> {
    this.scannerAnswer = await trySavingListingDoorCodes(
      this,
      editorBrowser(this),
      listing,
    );
  },
);

When(
  "the organiser tries to save the {word} door's tickets for offline reading",
  async function (this: TicketsWorld, listing: string): Promise<void> {
    // The request carries the organiser's own session, so the refusal is
    // the door's answer and not a missing sign-in.
    this.scannerAnswer = await trySavingListingDoorCodes(
      this,
      await openAdminPage(this, "/admin/listings"),
      listing,
    );
  },
);

Then(
  "the site saves no list for the {word}",
  function (this: TicketsWorld, _listing: string): void {
    // The listing has no door behind it, so there is no list to save.
    expect(this.scannerAnswer).toBe(404);
  },
);

Then(
  "the site refuses to save the {word}'s list",
  function (this: TicketsWorld, _listing: string): void {
    // Refused outright for want of door duties, not merely sent away.
    expect(this.scannerAnswer).toBe(403);
  },
);

Then(
  "the {word} door's saved list holds one-way codes for {word}'s and {word}'s tickets",
  function (
    this: TicketsWorld,
    door: string,
    first: string,
    second: string,
  ): Promise<void> {
    return expectSavedCodesFor(this, door, listingCacheName, first, second);
  },
);

Then(
  "the {word} group door's saved list holds one-way codes for {word}'s and {word}'s tickets",
  function (
    this: TicketsWorld,
    door: string,
    first: string,
    second: string,
  ): Promise<void> {
    return expectSavedCodesFor(this, door, groupCacheName, first, second);
  },
);

Then(
  "the {word} door's saved list holds no ticket code in full",
  function (this: TicketsWorld, door: string): void {
    expectNoTicketCodesIn(this, door);
  },
);

Then(
  "the {word} group door's saved list holds no ticket code in full",
  function (this: TicketsWorld, door: string): void {
    expectNoTicketCodesIn(this, door);
  },
);

Then(
  "the {word} door's saved list names nobody",
  function (this: TicketsWorld, door: string): void {
    expectSavedListNamesNobody(this, door);
  },
);

Then(
  "the {word} group door's saved list names nobody",
  function (this: TicketsWorld, door: string): void {
    expectSavedListNamesNobody(this, door);
  },
);

Then(
  "the {word} door's saved list is empty",
  async function (this: TicketsWorld, door: string): Promise<void> {
    await expectSavedListEmpty(this, door, listingCacheName);
  },
);

When(
  "the organiser delivers {word}'s saved check-in at the {word} door",
  async function (
    this: TicketsWorld,
    who: string,
    listing: string,
  ): Promise<void> {
    this.doorAnswer = await deliverAtListingDoor(this, listing, who);
  },
);

When(
  "the organiser delivers {word}'s saved check-in at the {word} group door",
  async function (
    this: TicketsWorld,
    who: string,
    groupName: string,
  ): Promise<void> {
    this.doorAnswer = await deliverAtGroupDoor(this, groupName, who);
  },
);

When(
  "the organiser delivers {int} of {word}'s saved tickets at the {word} door",
  async function (
    this: TicketsWorld,
    places: number,
    who: string,
    listing: string,
  ): Promise<void> {
    this.doorAnswer = await deliverAtListingDoor(this, listing, who, places);
  },
);

When(
  "the organiser delivers the same saved check-in again at the {word} door",
  async function (this: TicketsWorld, listing: string): Promise<void> {
    this.doorAnswer = await redeliverAtListingDoor(this, listing);
  },
);

When(
  "the organiser delivers the same saved check-in again at the {word} group door",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    this.doorAnswer = await redeliverAtGroupDoor(this, groupName);
  },
);

When(
  "the organiser delivers the saved check-in the {word} door saved for {word} at the {word} door",
  async function (
    this: TicketsWorld,
    savedAt: string,
    who: string,
    listing: string,
  ): Promise<void> {
    this.doorAnswer = await deliverSavedFromAnotherDoor(
      this,
      listing,
      savedAt,
      who,
    );
  },
);

When(
  "the organiser delivers a saved check-in that names nobody at the {word} door",
  async function (this: TicketsWorld, listing: string): Promise<void> {
    this.doorAnswer = await deliverUnknownCode(this, listing);
  },
);

Then(
  "the door refuses the saved check-in",
  function (this: TicketsWorld): void {
    expect(savedAnswer(this).status).toBe("not_found");
  },
);

Then(
  "nobody has let {word} in at the {word} door",
  async function (
    this: TicketsWorld,
    who: string,
    _listing: string,
  ): Promise<void> {
    expect(await placesAdmittedFor(this, who)).toBe(0);
  },
);

Then(
  "the {word} door has let {int} of {word}'s tickets in",
  async function (
    this: TicketsWorld,
    _listing: string,
    places: number,
    who: string,
  ): Promise<void> {
    expect(await placesAdmittedFor(this, who)).toBe(places);
  },
);

Then(
  "the {word} group door has let {int} of {word}'s tickets in",
  async function (
    this: TicketsWorld,
    _groupName: string,
    places: number,
    who: string,
  ): Promise<void> {
    expect(await placesAdmittedFor(this, who)).toBe(places);
  },
);
