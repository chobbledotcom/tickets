// jscpd:ignore-start

import { Given, Then } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import { browserSeenBy, CUSTOMER } from "#test/specs/support/browser.ts";
import { whatTheCustomerSees } from "#test/specs/support/list-narrowing.ts";
import {
  expectBelowTheBundles,
  expectBundlesGatheredFirst,
  expectNoWayInto,
  expectOffered,
  groupHolding,
  openedFromALinkTheyWereGiven,
  type PartState,
  sellsSomethingNobodyAttends,
  sellsSomethingQuietly,
  siteIsCalled,
  takeOffSale,
} from "#test/specs/support/public-list.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "the site sells a {word} that nobody attends",
  function (this: TicketsWorld, name: string): Promise<void> {
    return sellsSomethingNobodyAttends(this, name);
  },
);

Given(
  "the site quietly sells a {word}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return sellsSomethingQuietly(this, name);
  },
);

Given(
  "the {word} is taken off sale",
  function (this: TicketsWorld, name: string): Promise<void> {
    return takeOffSale(this, name);
  },
);

Given(
  "the site is called {string}",
  function (this: TicketsWorld, title: string): Promise<void> {
    return siteIsCalled(title);
  },
);

Given(
  "a {word} group holding a {word}",
  function (this: TicketsWorld, group: string, part: string): Promise<void> {
    return groupHolding(this, group, [{ name: part, state: "on sale" }]);
  },
);

Given(
  "a {word} group holding a {word}, described as {string}",
  function (
    this: TicketsWorld,
    group: string,
    part: string,
    describedAs: string,
  ): Promise<void> {
    return groupHolding(this, group, [{ name: part, state: "on sale" }], {
      describedAs,
    });
  },
);

Given(
  "a quiet {word} group holding a {word}",
  function (this: TicketsWorld, group: string, part: string): Promise<void> {
    return groupHolding(this, group, [{ name: part, state: "on sale" }], {
      keptOffTheList: true,
    });
  },
);

Given(
  "a/an {word} group holding nothing",
  function (this: TicketsWorld, group: string): Promise<void> {
    return groupHolding(this, group, []);
  },
);

Given(
  "a {word} bundle holding a {word}",
  function (this: TicketsWorld, bundle: string, part: string): Promise<void> {
    return groupHolding(this, bundle, [{ name: part, state: "on sale" }], {
      asBundle: true,
    });
  },
);

Given(
  "a/an {word} bundle holding nothing",
  function (this: TicketsWorld, bundle: string): Promise<void> {
    return groupHolding(this, bundle, [], { asBundle: true });
  },
);

/** A bundle of two parts where the second one cannot be sold. A bundle is all
 * or nothing, so what stops the second part is the only thing that differs. */
const bundleWithAStuckPart = (
  world: TicketsWorld,
  bundle: string,
  first: string,
  second: string,
  state: PartState,
): Promise<void> =>
  groupHolding(
    world,
    bundle,
    [
      { name: first, state: "on sale" },
      { name: second, state },
    ],
    { asBundle: true },
  );

Given(
  "a {word} bundle holding a {word} and a {word} with no room left",
  function (
    this: TicketsWorld,
    bundle: string,
    first: string,
    second: string,
  ): Promise<void> {
    return bundleWithAStuckPart(this, bundle, first, second, "full");
  },
);

Given(
  "a {word} bundle holding a {word} and a {word} that is off sale",
  function (
    this: TicketsWorld,
    bundle: string,
    first: string,
    second: string,
  ): Promise<void> {
    return bundleWithAStuckPart(this, bundle, first, second, "off sale");
  },
);

Then(
  "the list offers the {word}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return expectOffered(this, name);
  },
);

Then(
  "the list does not offer the {word}",
  function (this: TicketsWorld, name: string): Promise<void> {
    return expectNoWayInto(this, name);
  },
);

Then(
  "the list says the {word} can be booked",
  function (this: TicketsWorld, _name: string): void {
    expect(whatTheCustomerSees(this)).toContain(t("public.book_now"));
  },
);

Then(
  "the list says the {word} can be bought, not booked",
  function (this: TicketsWorld, _name: string): void {
    const page = whatTheCustomerSees(this);
    expect(page).toContain(t("public.buy_now"));
    expect(page).not.toContain(t("public.book_now"));
  },
);

Then(
  "the list says the {word} is {string}",
  function (this: TicketsWorld, _name: string, words: string): void {
    expect(whatTheCustomerSees(this)).toContain(words);
  },
);

Then("the list is empty", function (this: TicketsWorld): void {
  expect(whatTheCustomerSees(this)).toContain(t("public.no_listings_listed"));
});

Then(
  "the list is headed {string}",
  function (this: TicketsWorld, title: string): void {
    expect(whatTheCustomerSees(this)).toContain(title);
  },
);

Then(
  "a customer given the {word} link can still open it",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await openedFromALinkTheyWereGiven(this, name)).toContain(name);
  },
);

Then(
  "the list gathers the bundles first, naming the {word} before the {word}",
  function (this: TicketsWorld, first: string, second: string): void {
    expectBundlesGatheredFirst(this, first, second);
  },
);

Then(
  "the list puts the {word} below them, under everything on sale",
  function (this: TicketsWorld, name: string): void {
    expectBelowTheBundles(this, name);
  },
);

Then(
  "the customer is asked to sign in instead",
  function (this: TicketsWorld): void {
    // Where they ended up, not merely what the page says: an unopened site
    // sends them to the sign-in page rather than showing them an empty list.
    expect(browserSeenBy(this, CUSTOMER).currentUrl).toBe("/admin/login");
  },
);
