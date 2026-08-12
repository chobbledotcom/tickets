// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { formatCurrency } from "#shared/currency.ts";
import { scenarioBrowser } from "#test/specs/support/browser.ts";
import { makeRefundLedgerUnavailable } from "#test/specs/support/refund-safety/faults.ts";
import {
  refundSafety,
  safetyBooking,
} from "#test/specs/support/refund-safety/state.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import {
  completedRefundFor,
  expectOwnerWasTold,
  expectProviderSendCount,
  refundProviderFor,
  returnedChargeFor,
  untouchedChargeFor,
} from "./common.ts";

// jscpd:ignore-end

Given(
  "Money will temporarily refuse to record {word}'s refund",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const booking = safetyBooking(this, who);
    const provider = refundProviderFor(this);
    provider.showCharge(
      "stripe",
      booking.paymentReference,
      untouchedChargeFor(this, who),
    );
    provider.answer(
      "stripe",
      booking.paymentReference,
      completedRefundFor(this, who),
      { resource: returnedChargeFor(this, who), status: "found" },
    );
    refundSafety(this).moneyFault = await makeRefundLedgerUnavailable(
      this.cleanup,
    );
  },
);

Then(
  "the owner is warned that the provider returned {word}'s money but Money did not record it",
  function (this: TicketsWorld, _who: string): void {
    expectOwnerWasTold(
      this,
      "The payment provider sent the refund",
      "could not be recorded in Money",
    );
  },
);

Then(
  "the owner is told to fix Money and refresh the payment status",
  function (this: TicketsWorld): void {
    expectOwnerWasTold(this, "Fix Money, then refresh payment status");
  },
);

Then(
  "Stripe received one request to return {word}'s money",
  function (this: TicketsWorld, who: string): void {
    expectProviderSendCount(this, "stripe", who, 1);
  },
);

When(
  "Money can record refunds again",
  async function (this: TicketsWorld): Promise<void> {
    const fault = refundSafety(this).moneyFault;
    if (fault === undefined) {
      throw new Error("Money was never made unavailable in this story");
    }
    await fault.restore();
  },
);

Then(
  "{word}'s booking says the {float} was refunded",
  function (this: TicketsWorld, who: string, pounds: number): void {
    expect(safetyBooking(this, who).amount).toBe(Math.round(pounds * 100));
    const page = scenarioBrowser(this).pageText;
    expect(page).toContain(formatCurrency(Math.round(pounds * 100)));
    expect(page).toContain("Refunded");
  },
);
