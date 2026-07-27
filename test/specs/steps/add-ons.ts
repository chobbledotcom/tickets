// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  bookingLinkFor,
  bookingPageFor,
  everythingForSale,
  expectCustomerCannotOpen,
  expectCustomerCanOpen,
  sellHiddenBundle,
  sellOnItsOwn,
  sellWithAddOn,
} from "#test/specs/support/add-ons.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The page of everything for sale, as the customer last saw it. */
const forSalePage = (world: TicketsWorld): TestBrowser =>
  requiredWorldValue(world.customerBrowser, "the page the customer saw");

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
    this.customerBrowser = await everythingForSale();
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
    expect(page.pageText).toContain(name);
    expect(page.links.map(({ href }) => href)).toContain(
      bookingLinkFor(this, name),
    );
  },
);

Then(
  "the {word} is not called an add-on there",
  function (this: TicketsWorld, name: string): void {
    // The note belongs to things that are only ever sold alongside something
    // else, so it must not follow this one onto the page.
    expect(forSalePage(this).pageText).toContain(name);
    expect(
      forSalePage(this).containsText("as an add-on to another booking"),
    ).toBe(false);
  },
);

Then(
  "the {word} is still offered when booking the {word}",
  async function (
    this: TicketsWorld,
    addOn: string,
    mainThing: string,
  ): Promise<void> {
    // Selling it on its own must not take it off the page of the thing it goes
    // with — that is where most people will meet it.
    const page = await bookingPageFor(this, mainThing);
    expect(page.pageText).toContain(addOn);
  },
);

Then(
  "the {word} is still offered too",
  function (this: TicketsWorld, name: string): void {
    expect(forSalePage(this).links.map(({ href }) => href)).toContain(
      bookingLinkFor(this, name),
    );
  },
);
