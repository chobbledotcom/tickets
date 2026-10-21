// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  menusOfferPage,
  ownerMovesPageUp,
  ownerSetsPageHidden,
  ownerTakesPageDown,
  ownerTriesToTakePageDown,
  ownerWritesPage,
  ownerWritesPages,
  pageAddress,
  pageEditorShowsHidden,
  pageIsOfferedAMoveUp,
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

When(
  "the owner moves {word} up",
  function (this: TicketsWorld, name: string): Promise<void> {
    return ownerMovesPageUp(this, name);
  },
);

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
  async function (this: TicketsWorld, name: string): Promise<void> {
    const told = await ownerTakesPageDown(this, name, name);
    expect(told).toContain(t("site.pages.deleted"));
  },
);

When(
  "the owner tries to take down {word} by typing {word}",
  async function (
    this: TicketsWorld,
    name: string,
    typed: string,
  ): Promise<void> {
    await ownerTriesToTakePageDown(this, name, typed);
  },
);

Then(
  "the owner is told the page name does not match",
  function (this: TicketsWorld): void {
    expect(whatOwnerWasTold(this)).toContain("does not match");
  },
);

Then(
  "{word} is already at the top",
  async function (this: TicketsWorld, name: string): Promise<void> {
    // No arrow at all is how the site says "no further" — there is no request
    // that could wrap the page round to the bottom.
    expect(await pageIsOfferedAMoveUp(this, name)).toBe(false);
  },
);

When(
  "the owner keeps {word} off the menus",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await ownerSetsPageHidden(this, name, true);
  },
);

When(
  "the owner puts {word} back on the menus",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await ownerSetsPageHidden(this, name, false);
  },
);

Given(
  "the owner has kept {word} off the menus",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await ownerSetsPageHidden(this, name, true);
    // The set-up has to have worked, or the scenario it feeds proves nothing.
    expect(whatOwnerWasTold(this)).toContain(t("site.pages.updated"));
  },
);

Then(
  "the editor for {word} opens with the Hidden box ticked",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await pageEditorShowsHidden(this, name, true);
  },
);

Then(
  "the editor for {word} opens with the Hidden box clear",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await pageEditorShowsHidden(this, name, false);
  },
);

Then(
  "no menu offers {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await menusOfferPage(await pageAddress(name))).toBe(false);
  },
);

Then(
  "a menu offers {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await menusOfferPage(await pageAddress(name))).toBe(true);
  },
);
