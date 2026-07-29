// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  ownerMovesPageUp,
  ownerTakesPageDown,
  ownerWritesPage,
  ownerWritesPages,
  pagesInOrder,
  visitorReading,
  whatOwnerWasTold,
} from "#test/specs/support/site-pages.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "the owner is writing the site's pages",
  function (this: TicketsWorld): Promise<void> {
    return ownerWritesPages(this);
  },
);

/** Writing a page, however the story words it — one scenario writes it as the
 * thing under test, the others only need one to exist first. */
const writesPage = async function (
  this: TicketsWorld,
  name: string,
  address: string,
): Promise<void> {
  await ownerWritesPages(this);
  await ownerWritesPage(this, name, address);
};

When("the owner writes a page called {word} at {string}", writesPage);

Given(
  "the owner has written a page called {word} at {string}",
  async function (
    this: TicketsWorld,
    name: string,
    address: string,
  ): Promise<void> {
    await writesPage.call(this, name, address);
    // The set-up has to have worked, or the scenario it feeds proves nothing.
    expect(whatOwnerWasTold(this)).toContain("Page created");
  },
);

Given(
  "the owner has written pages called {word}, {word} and {word}",
  async function (
    this: TicketsWorld,
    first: string,
    second: string,
    third: string,
  ): Promise<void> {
    await ownerWritesPages(this);
    for (const name of [first, second, third]) {
      await ownerWritesPage(this, name, name.toLowerCase());
    }
    expect(await pagesInOrder()).toEqual([first, second, third]);
  },
);

Then("the owner is told it saved", function (this: TicketsWorld): void {
  expect(whatOwnerWasTold(this)).toContain("Page created");
});

Then("the owner is told that will not do", function (this: TicketsWorld): void {
  // The site's own words for an address it will not accept, so a refusal that
  // stopped explaining itself fails here rather than passing quietly.
  expect(whatOwnerWasTold(this)).toContain("slug");
});

Then(
  "a visitor reading {string} is shown {word}",
  async function (
    this: TicketsWorld,
    address: string,
    name: string,
  ): Promise<void> {
    const { answered, said } = await visitorReading(address);
    expect(answered).toBe(200);
    expect(said).toContain(name);
  },
);

Then(
  "reading {string} leads nowhere",
  async function (this: TicketsWorld, address: string): Promise<void> {
    expect((await visitorReading(address)).answered).toBe(404);
  },
);

/** Moving a page up, said once at the start and again to show the top is the
 * top. Both wordings do the same thing. */
const movesUp = function (this: TicketsWorld, name: string): Promise<void> {
  return ownerMovesPageUp(this, name);
};

When("the owner moves {word} up", movesUp);
When("the owner moves {word} up again", movesUp);

Then(
  "the pages are offered in the order {word}, {word} and {word}",
  async function (
    this: TicketsWorld,
    first: string,
    second: string,
    third: string,
  ): Promise<void> {
    expect(await pagesInOrder()).toEqual([first, second, third]);
  },
);

When(
  "the owner takes down the page called {word}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return ownerTakesPageDown(this, name);
  },
);
