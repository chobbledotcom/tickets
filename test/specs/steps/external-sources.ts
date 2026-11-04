/**
 * Steps for noting where a record appears in another system, and asking where
 * it appears.
 */

// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { assert } from "@std/assert";
import {
  answerNames,
  diaryNotesListing,
  expectToldToTurnItOn,
  listingForStory,
  type Note,
  noteListing,
  ownerHasDiary,
  toolAsksWhereListingAppears,
  toolNotesListing,
} from "#test/specs/support/external-sources.ts";
import { organiserDeletesListing } from "#test/specs/support/privacy.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** One note, worded the way the story words it. */
const note = (listing: string, externalId: string, diary: string): Note => ({
  diary,
  externalId,
  listing,
});

Given(
  "a listing called {string}",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return listingForStory(this, listing);
  },
);

Given(
  "a diary called {string}",
  function (this: TicketsWorld, diary: string): Promise<void> {
    return ownerHasDiary(this, diary);
  },
);

Given(
  "the owner has noted that {string} is {string} in {string}",
  function (
    this: TicketsWorld,
    listing: string,
    externalId: string,
    diary: string,
  ): Promise<void> {
    return noteListing(this, note(listing, externalId, diary));
  },
);

When(
  "the tool notes that {string} is {string} in {string}",
  function (
    this: TicketsWorld,
    listing: string,
    externalId: string,
    diary: string,
  ): Promise<void> {
    return toolNotesListing(this, note(listing, externalId, diary));
  },
);

Then(
  "the tool is told to turn External sources on",
  function (this: TicketsWorld): void {
    expectToldToTurnItOn(this);
  },
);

When(
  "the owner deletes {string}",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return organiserDeletesListing(this, listing);
  },
);

Then(
  "{string} still notes {string}",
  async function (
    this: TicketsWorld,
    diary: string,
    listing: string,
  ): Promise<void> {
    assert(await diaryNotesListing(this, diary, listing));
  },
);

Then(
  "{string} no longer notes {string}",
  async function (
    this: TicketsWorld,
    diary: string,
    listing: string,
  ): Promise<void> {
    assert(!(await diaryNotesListing(this, diary, listing)));
  },
);

When(
  "the tool asks where {string} also appears",
  function (this: TicketsWorld, listing: string): Promise<void> {
    return toolAsksWhereListingAppears(this, listing);
  },
);

Then(
  "the answer names {string} in {string}",
  function (this: TicketsWorld, externalId: string, diary: string): void {
    assert(answerNames(this, externalId, diary));
  },
);
