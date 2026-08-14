// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { execute } from "#shared/db/client.ts";
import {
  contradictFirstPayment,
  correctFirstPayment,
  expectRefundEveryoneUnavailable,
  firstPaymentIsLastRefundCandidate,
  leaveFirstRefundCaseForOwner,
  leaveOnlyLaterIndexedPayment,
  openRefundEveryone,
  paidPlaceEach,
  payMoreListing,
  payYourOwnPrice,
  refuseNextRefund,
  tryToRefundEveryone,
} from "#test/specs/support/bulk-money.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  assertRenderedIncome,
  attendeeLegsOfKind,
  incomeOf,
  owedBy,
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
  "the owner tried the first refund and left its refund case unresolved",
  function (this: TicketsWorld): Promise<void> {
    return leaveFirstRefundCaseForOwner(this);
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

Given(
  "the first person's deposit exists only in old attendee data but their later balance payment is indexed",
  function (this: TicketsWorld): Promise<void> {
    return leaveOnlyLaterIndexedPayment(this);
  },
);

When(
  "the organiser tries to refund everyone and the provider turns it down",
  function (this: TicketsWorld): Promise<void> {
    return refuseNextRefund(this);
  },
);

When(
  "the organiser tries to refund everyone",
  function (this: TicketsWorld): Promise<void> {
    return tryToRefundEveryone(this);
  },
);

When(
  "the organiser opens Refund All",
  function (this: TicketsWorld): Promise<void> {
    return openRefundEveryone(this);
  },
);

Then(
  "Refund All stops before asking the provider to return money",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.bulkRefundMessage, "what the organiser was told"),
    ).toContain("Refund recovery");
    expect(requiredWorldValue(this.refundCalls, "refund calls")()).toBe(0);
  },
);

Then(
  "Refund All stops because older payment history is incomplete",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.bulkRefundMessage, "what the organiser was told"),
    ).toContain("payment provider");
    expect(requiredWorldValue(this.refundCalls, "refund calls")()).toBe(0);
  },
);

Then(
  "Refund All offers no way to send a refund",
  function (this: TicketsWorld): void {
    expectRefundEveryoneUnavailable(this);
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
  "the organiser is told {int} refund(s) worked and {int} remain(s)",
  function (this: TicketsWorld, worked: number, remaining: number): void {
    const told = requiredWorldValue(
      this.bulkRefundMessage,
      "what they were told",
    );
    expect(told).toContain(
      `${worked} refund${worked === 1 ? "" : "s"} succeeded`,
    );
    expect(told).toContain(
      `${remaining} refund${remaining === 1 ? "" : "s"} remain`,
    );
    expect(requiredWorldValue(this.refundCalls, "refund calls")()).toBe(worked);
  },
);

Then(
  "the organiser is told {int} refund(s) remain",
  function (this: TicketsWorld, remaining: number): void {
    expect(
      requiredWorldValue(this.bulkRefundMessage, "what they were told"),
    ).toContain(`${remaining} refund${remaining === 1 ? "" : "s"} remain`);
  },
);

Then(
  "exactly {int} person has their money back",
  async function (this: TicketsWorld, count: number): Promise<void> {
    const returned = await Promise.all(
      requiredWorldValue(this.attendeeIds, "the people who paid").map(
        async (id) => (await attendeeLegsOfKind(id, "refund_cash")).length,
      ),
    );
    expect(returned.filter((legs) => legs === 1)).toHaveLength(count);
  },
);

Then(
  "all {int} people have their money back",
  async function (this: TicketsWorld, count: number): Promise<void> {
    const people = requiredWorldValue(this.attendeeIds, "the people who paid");
    expect(people).toHaveLength(count);
    for (const id of people) {
      expect(await attendeeLegsOfKind(id, "refund_cash")).toHaveLength(1);
    }
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
    expect(await worldBalance()).toBe(0 - minorUnits(earned));
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
