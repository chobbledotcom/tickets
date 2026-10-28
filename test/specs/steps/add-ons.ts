// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  bookingLinkFor,
  bookingPageFor,
  everythingForSale,
  expectCustomerCannotOpen,
  expectCustomerCanOpen,
  offerChoiceOnPages,
  offerChoiceThroughAddOnGroup,
  sellHiddenBundle,
  sellOnItsOwn,
  sellWithAddOn,
  tryStopSellingOnItsOwn,
  tryTakeOffSale,
} from "#test/specs/support/add-ons.ts";
import {
  browserSeenBy,
  CUSTOMER,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import { ownerLastTold } from "#test/specs/support/buyer-questions.ts";
import { copyLoaded } from "#test/specs/support/copy.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The page of everything for sale, as the customer last saw it. */
const forSalePage = (world: TicketsWorld): TestBrowser =>
  browserSeenBy(world, CUSTOMER);

Given(
  "a {word} sold with a {word} that can also be bought on its own",
  function (this: TicketsWorld, mainThing: string, addOn: string) {
    return sellWithAddOn(this, mainThing, addOn, true);
  },
);

Given(
  "a {word} sold with a {word} that is only an add-on",
  function (this: TicketsWorld, mainThing: string, addOn: string) {
    return sellWithAddOn(this, mainThing, addOn, false);
  },
);

Given(
  "a hidden {word} whose {word} could be bought on its own",
  function (this: TicketsWorld, bundle: string, part: string) {
    return sellHiddenBundle(this, bundle, part);
  },
);

When(
  "the organiser starts selling the {word} on its own",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await sellOnItsOwn(this, name, true);
  },
);

When(
  "the organiser stops selling the {word} on its own",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await sellOnItsOwn(this, name, false);
  },
);

When(
  "a customer looks at everything for sale",
  async function (this: TicketsWorld): Promise<void> {
    rememberBrowser(this, CUSTOMER, await everythingForSale());
  },
);

Then(
  "a customer can open the {word}'s own page",
  function (this: TicketsWorld, name: string): Promise<void> {
    return expectCustomerCanOpen(this, name);
  },
);

Then(
  "a customer cannot open the {word}'s own page",
  function (this: TicketsWorld, name: string): Promise<void> {
    return expectCustomerCannotOpen(this, name);
  },
);

Then(
  "the {word} is offered with a link to its own page",
  function (this: TicketsWorld, name: string): void {
    const page = forSalePage(this);
    assertStringIncludes(page.pageText, name);
    assertArrayIncludes(
      page.links.map(({ href }) => href),
      [bookingLinkFor(this, name)],
    );
  },
);

Then(
  "the {word} is not called an add-on there",
  function (this: TicketsWorld, name: string): void {
    // The note belongs to things that are only ever sold alongside something
    // else, so it must not follow this one onto the page.
    assertStringIncludes(forSalePage(this).pageText, name);
    expect(
      forSalePage(this).containsText("as an add-on to another booking"),
    ).toBe(false);
  },
);

Then(
  "the {string} is still offered when booking the {word}",
  async function (
    this: TicketsWorld,
    offered: string,
    mainThing: string,
  ): Promise<void> {
    // The edit must not take it off a page that still offers it.
    const page = await bookingPageFor(this, mainThing);
    assertStringIncludes(page.pageText, offered);
  },
);

Then(
  "the {word} is still offered too",
  function (this: TicketsWorld, name: string): void {
    assertArrayIncludes(
      forSalePage(this).links.map(({ href }) => href),
      [bookingLinkFor(this, name)],
    );
  },
);

Given(
  "a buyer's choice called {string} offered on the {word}'s own page only",
  function (this: TicketsWorld, choice: string, addOn: string): Promise<void> {
    return offerChoiceOnPages(this, choice, addOn);
  },
);

Given(
  "a buyer's choice called {string} offered through the group the {word} is in",
  function (this: TicketsWorld, choice: string, addOn: string): Promise<void> {
    return offerChoiceThroughAddOnGroup(this, addOn, choice);
  },
);

Given(
  "a buyer's choice called {string} offered on the {word}'s page as well as the {word}'s",
  function (
    this: TicketsWorld,
    choice: string,
    mainThing: string,
    addOn: string,
  ): Promise<void> {
    return offerChoiceOnPages(this, choice, mainThing, addOn);
  },
);

When(
  "the organiser tries to stop selling the {word} on its own",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await tryStopSellingOnItsOwn(this, name);
  },
);

When(
  "the organiser tries to take the {word} off sale",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await tryTakeOffSale(this, name);
  },
);

Then(
  "the organiser is told {string} still needs the {word}'s page",
  async function (
    this: TicketsWorld,
    choice: string,
    _addOn: string,
  ): Promise<void> {
    // The unmark save and the refused take-off-sale both refuse through the
    // add-on reachability guard, whose words name the stranded choice.
    await copyLoaded("modifiers");
    assertStringIncludes(
      ownerLastTold(this),
      t("modifiers.err_child_only_addon", { name: choice }),
    );
  },
);
