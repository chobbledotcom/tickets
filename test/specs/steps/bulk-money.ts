// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import {
  everyoneRefunded,
  paidPlaceEach,
  payMoreListing,
  payYourOwnPrice,
  refundedPeople,
} from "#test/specs/support/bulk-money.ts";
import { listingIdFor, minorUnits } from "#test/specs/support/money.ts";
import {
  assertRenderedIncome,
  attendeeLegsOfKind,
  incomeOf,
  owedBy,
  sumOfAllBalances,
  worldBalance,
} from "#test/specs/support/money-reads.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "three people each paid {word} for a {word} place",
  async function (
    this: TicketsWorld,
    price: string,
    listing: string,
  ): Promise<void> {
    await paidPlaceEach(this, listing, price, ["One", "Two", "Three"]);
    // The premise the rest of the story rests on: all three sales counted.
    expect(await incomeOf(listingIdFor(this, listing))).toBe(
      3 * minorUnits(price),
    );
  },
);

When(
  "the organiser refunds everyone and the provider turns down the second",
  function (this: TicketsWorld): Promise<void> {
    return everyoneRefunded(this);
  },
);

Then(
  "the organiser is told {int} refunds worked and {int} failed",
  function (this: TicketsWorld, worked: number, failed: number): void {
    const told = requiredWorldValue(
      this.bulkRefundMessage,
      "what they were told",
    );
    expect(told).toContain(`${worked} refunds succeeded`);
    expect(told).toContain(`There was ${failed} failure`);
    // Every booking was tried, not just the ones before the failure.
    expect(requiredWorldValue(this.refundCalls, "refund calls")()).toBe(
      worked + failed,
    );
  },
);

Then(
  "the two who were refunded have their money back",
  async function (this: TicketsWorld): Promise<void> {
    const { refunded } = refundedPeople(this);
    for (const id of refunded) {
      expect((await attendeeLegsOfKind(id, "refund_cash")).length).toBe(1);
    }
  },
);

Then(
  "the one who was not still has their place, and the {word} has earned {word}",
  async function (
    this: TicketsWorld,
    listing: string,
    earned: string,
  ): Promise<void> {
    const { turnedDown } = refundedPeople(this);
    expect((await attendeeLegsOfKind(turnedDown, "refund_cash")).length).toBe(
      0,
    );
    expect(await incomeOf(listingIdFor(this, listing))).toBe(
      minorUnits(earned),
    );
    expect(await sumOfAllBalances()).toBe(0);
  },
);

Given(
  "a {word} listing that asks {word} and lets people pay more",
  function (this: TicketsWorld, listing: string, asks: string): Promise<void> {
    return payMoreListing(this, listing, asks);
  },
);

When(
  "a customer chooses to pay {word}",
  function (this: TicketsWorld, chosen: string): Promise<void> {
    return payYourOwnPrice(this, chosen);
  },
);

Then(
  "the {word} has earned {word}",
  async function (
    this: TicketsWorld,
    listing: string,
    earned: string,
  ): Promise<void> {
    expect(await incomeOf(listingIdFor(this, listing))).toBe(
      minorUnits(earned),
    );
    expect(await worldBalance()).toBe(-minorUnits(earned));
  },
);

Then(
  "the organiser sees {word} wherever the income is shown",
  async function (this: TicketsWorld, earned: string): Promise<void> {
    const listingId = requiredWorldValue(this.listingId, "the listing");
    // Both places the figure appears must agree with what was really paid.
    await assertRenderedIncome(listingId, minorUnits(earned));
    expect(await owedBy((await getAttendeesRaw(listingId))[0]!.id)).toBe(0);
  },
);
