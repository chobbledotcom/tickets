// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  ownerMovesPageUp,
  ownerTakesPageDown,
  ownerWritesPage,
  ownerWritesPages,
  pagesInOrder,
  visitorReading,
  whatOwnerWasTold,
  wordsOnlyOn,
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
    expect(await pagesInOrder(this)).toEqual([first, second, third]);
  },
);

Then("the owner is told it saved", function (this: TicketsWorld): void {
  expect(whatOwnerWasTold(this)).toContain("Page created");
});

Then("the owner is told that will not do", function (this: TicketsWorld): void {
  // One of the site's own two refusals, read from the catalog rather than
  // written out here, so a refusal that stopped explaining itself fails.
  const told = whatOwnerWasTold(this);
  const refusals = [
    t("site.pages.error.reserved"),
    t("site.pages.error.slug_taken"),
  ];
  expect(refusals.some((refusal) => told.includes(refusal))).toBe(true);
});

Then(
  "the site has no page called {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    // A refusal that wrote the row anyway and then complained would satisfy
    // the message check on its own, so the story reads the pages back.
    expect(await pagesInOrder(this)).not.toContain(name);
  },
);

Then(
  "a visitor reading {string} is shown {word}",
  async function (
    this: TicketsWorld,
    address: string,
    name: string,
  ): Promise<void> {
    const { answered, said } = await visitorReading(address);
    expect(answered).toBe(200);
    // Wording only this page carries. Every page's name is in the navigation on
    // every page, so looking for the name alone would pass against any of them.
    expect(said).toContain(wordsOnlyOn(name));
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
    expect(await pagesInOrder(this)).toEqual([first, second, third]);
  },
);

When(
  "the owner takes down the page called {word}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return ownerTakesPageDown(this, name);
  },
);
