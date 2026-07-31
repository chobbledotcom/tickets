// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { ownerLastTold } from "#test/specs/support/buyer-questions.ts";
import {
  asMoney,
  codeBoxOffered,
  customerAsksPrice,
  customerPaysWithCode,
  expectDiscountLine,
  organiserCreatesCode,
  priceSummary,
  summaryTotal,
} from "#test/specs/support/discount-codes.ts";
import { sellPlacesAt } from "#test/specs/support/money.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  modifierUsageAmount,
  modifierUsageCount,
} from "#test-utils/modifiers.ts";

// jscpd:ignore-end

Given(
  "the site sells places at the {word} for {float}",
  async function (this: TicketsWorld, name: string, pounds: number) {
    await sellPlacesAt(this, name, pounds.toFixed(2));
  },
);

When(
  "the organiser creates a promo code {string} taking {int} percent off",
  function (this: TicketsWorld, code: string, percent: number): Promise<void> {
    return organiserCreatesCode(this, code, percent);
  },
);

Given(
  "the organiser has a promo code {string} taking {int} percent off",
  function (this: TicketsWorld, code: string, percent: number): Promise<void> {
    return organiserCreatesCode(this, code, percent);
  },
);

Then(
  "the organiser is told the modifier was created",
  function (this: TicketsWorld): void {
    expect(ownerLastTold(this)).toContain("Modifier created");
  },
);

/** Both box steps ask the same question of the served page; only the answer
 * they insist on differs. */
const boxExpected = (offered: boolean) =>
  async function (this: TicketsWorld, listing: string): Promise<void> {
    expect(await codeBoxOffered(this, listing)).toBe(offered);
  };

Then("the {word} booking page offers no promo code box", boxExpected(false));

Then("the {word} booking page offers a promo code box", boxExpected(true));

/** A step that hands the listing and the typed code straight to one journey. */
const codeJourney = (
  journey: (
    world: TicketsWorld,
    listing: string,
    code: string,
  ) => Promise<void>,
) =>
  function (this: TicketsWorld, listing: string, code: string): Promise<void> {
    return journey(this, listing, code);
  };

When(
  "a customer asks the price of a {word} place with the code {string}",
  codeJourney(customerAsksPrice),
);

Then(
  "the summary shows the place at {float}",
  function (this: TicketsWorld, pounds: number): void {
    expect(priceSummary(this)).toContain(asMoney(pounds.toFixed(2)));
  },
);

Then(
  "the summary shows the discount line {string} taking off {float}",
  function (this: TicketsWorld, code: string, pounds: number): void {
    expectDiscountLine(this, code, pounds.toFixed(2));
  },
);

Then(
  "the summary total is {float}",
  function (this: TicketsWorld, pounds: number): void {
    expect(summaryTotal(this)).toContain(asMoney(pounds.toFixed(2)));
  },
);

Then("the summary shows no discount line", function (this: TicketsWorld): void {
  // No negative figure anywhere: nothing was taken off at all.
  expect(priceSummary(this)).not.toContain("-£");
});

Then(
  "the summary never names {string}",
  function (this: TicketsWorld, code: string): void {
    expect(priceSummary(this)).not.toContain(code);
  },
);

When(
  "a customer books a {word} place with the code {string} and pays",
  codeJourney(customerPaysWithCode),
);

Then(
  "the code {string} has been used once, worth {float}",
  async function (this: TicketsWorld, code: string, pounds: number) {
    const modifierId = this.things.require("record", code);
    expect(await modifierUsageCount(modifierId)).toBe(1);
    expect(await modifierUsageAmount(modifierId)).toBe(
      Math.round(pounds * 100),
    );
  },
);

Then(
  "the activity log says the code {string} took {float} off",
  async function (this: TicketsWorld, code: string, pounds: number) {
    expect(await activityMessages()).toContain(
      `Promo code '${code}' used: ${asMoney(pounds.toFixed(2))} off`,
    );
  },
);
