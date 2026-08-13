// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { execute } from "#shared/db/client.ts";
import {
  acknowledgeFirstPaymentReview,
  contradictFirstPayment,
  correctFirstPayment,
  everyoneRefunded,
  firstPaymentIsLastRefundCandidate,
  paidPlaceEach,
  payMoreListing,
  payYourOwnPrice,
  refundedPeople,
  tryToRefundEveryone,
} from "#test/specs/support/bulk-money.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
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
  "{int} people each paid {word} for a {word} place",
  async function (
    this: TicketsWorld,
    count: number,
    price: string,
    listing: string,
  ): Promise<void> {
    const people = ["One", "Two", "Three", "Four", "Five", "Six"].slice(
      0,
      count,
    );
    expect(people).toHaveLength(count);
    await paidPlaceEach(this, listing, price, people);
    // The premise the rest of the story rests on: every sale counted.
    expect(await incomeOf(listingIdNamed(this, listing))).toBe(
      count * minorUnits(price),
    );
  },
);

Given(
  "the first payment is last in Refund All's payment set",
  function (this: TicketsWorld): Promise<void> {
    return firstPaymentIsLastRefundCandidate(this);
  },
);

Given(
  "the provider reports returning more than it took on the first payment",
  function (this: TicketsWorld): void {
    contradictFirstPayment(this);
  },
);

Given(
  "the owner tried the first refund and acknowledged its review",
  function (this: TicketsWorld): Promise<void> {
    return acknowledgeFirstPaymentReview(this);
  },
);

Given(
  "the provider corrects the first payment to show no refund",
  function (this: TicketsWorld): void {
    correctFirstPayment(this);
  },
);

Given(
  "the first payment was stored before refund indexes existed",
  async function (this: TicketsWorld): Promise<void> {
    const [first] = requiredWorldValue(this.attendeeIds, "the people who paid");
    if (first === undefined) throw new Error("Nobody paid first");
    await execute(
      `UPDATE processed_payments
          SET payment_reference_index = ''
        WHERE attendee_id = ?`,
      [first],
    );
  },
);

When(
  "the organiser refunds everyone and the provider turns down the first",
  function (this: TicketsWorld): Promise<void> {
    return everyoneRefunded(this);
  },
);

When(
  "the organiser tries to refund everyone",
  function (this: TicketsWorld): Promise<void> {
    return tryToRefundEveryone(this);
  },
);

Then(
  "Refund All stops before asking the provider to return money",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.bulkRefundMessage, "what the organiser was told"),
    ).toContain("needs an owner review");
    expect(requiredWorldValue(this.refundCalls, "refund calls")()).toBe(0);
  },
);

Then(
  "Refund All stops because older payment history is incomplete",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.bulkRefundMessage, "what the organiser was told"),
    ).toContain("older payment history");
    expect(requiredWorldValue(this.refundCalls, "refund calls")()).toBe(0);
  },
);

Then(
  "all {int} people still have their payments",
  async function (this: TicketsWorld, count: number): Promise<void> {
    const attendeeIds = requiredWorldValue(
      this.attendeeIds,
      "the people who paid",
    );
    expect(attendeeIds).toHaveLength(count);
    for (const attendeeId of attendeeIds) {
      expect(await attendeeLegsOfKind(attendeeId, "payment")).toHaveLength(1);
      expect(await attendeeLegsOfKind(attendeeId, "refund_cash")).toEqual([]);
    }
  },
);

Then(
  "the organiser is told {int} refund(s) worked and {int} failed",
  function (this: TicketsWorld, worked: number, failed: number): void {
    const told = requiredWorldValue(
      this.bulkRefundMessage,
      "what they were told",
    );
    expect(told).toContain(
      `${worked} refund${worked === 1 ? "" : "s"} succeeded`,
    );
    expect(told).toContain(`There was ${failed} failure`);
    // Every booking was tried, not just the ones before the failure.
    expect(requiredWorldValue(this.refundCalls, "refund calls")()).toBe(
      worked + failed,
    );
  },
);

Then(
  "the person who was refunded has their money back",
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
    expect(await incomeOf(listingIdNamed(this, listing))).toBe(
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
    expect(await incomeOf(listingIdNamed(this, listing))).toBe(
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
