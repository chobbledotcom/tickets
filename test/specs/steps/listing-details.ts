// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assert, assertStringIncludes } from "@std/assert";
import { ownerLastTold } from "#test/specs/support/buyer-questions.ts";
import {
  ownerKeepsDetail,
  ownerMarksListing,
  ownerRemovesDetail,
  visitorReadsListingPage,
} from "#test/specs/support/listing-details.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "the owner keeps a detail called {word} worded {string} or {string}",
  function (
    this: TicketsWorld,
    name: string,
    first: string,
    second: string,
  ): Promise<void> {
    return ownerKeepsDetail(this, name, [first, second]);
  },
);

When(
  "the owner marks the {word} as {string}",
  function (
    this: TicketsWorld,
    listingName: string,
    wording: string,
  ): Promise<void> {
    return ownerMarksListing(this, listingName, wording);
  },
);

Then(
  "a visitor reading the {word} page sees {word} stated as {string}",
  async function (
    this: TicketsWorld,
    listingName: string,
    detailName: string,
    wording: string,
  ): Promise<void> {
    const said = await visitorReadsListingPage(this, listingName);
    assertStringIncludes(said, detailName);
    assertStringIncludes(said, wording);
  },
);

Then(
  "a visitor reading the {word} page is not told {string}",
  async function (
    this: TicketsWorld,
    listingName: string,
    words: string,
  ): Promise<void> {
    assert(!(await visitorReadsListingPage(this, listingName)).includes(words));
  },
);

When(
  "the owner removes the detail {word}, typing {string}",
  function (this: TicketsWorld, _name: string, typed: string): Promise<void> {
    return ownerRemovesDetail(this, typed);
  },
);

Then(
  "the owner is told the detail's name does not match",
  function (this: TicketsWorld): void {
    assertStringIncludes(ownerLastTold(this), "Attribute name does not match");
  },
);

Then(
  "the owner is told the detail is deleted",
  function (this: TicketsWorld): void {
    assertStringIncludes(ownerLastTold(this), "Attribute deleted");
  },
);
