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

Then(
  "the {word} booking page offers no promo code box",
  async function (this: TicketsWorld, listing: string): Promise<void> {
    expect(await codeBoxOffered(this, listing)).toBe(false);
  },
);

Then(
  "the {word} booking page offers a promo code box",
  async function (this: TicketsWorld, listing: string): Promise<void> {
    expect(await codeBoxOffered(this, listing)).toBe(true);
  },
);

When(
  "a customer asks the price of a {word} place with the code {string}",
  function (this: TicketsWorld, listing: string, code: string): Promise<void> {
    return customerAsksPrice(this, listing, code);
  },
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

When(
  "a customer books a {word} place with the code {string} and pays",
  function (this: TicketsWorld, listing: string, code: string): Promise<void> {
    return customerPaysWithCode(this, listing, code);
  },
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
