// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { scenarioBrowser } from "#test/specs/support/browser.ts";
import { forgetStoredPaymentProvider } from "#test/specs/support/refund-safety/history.ts";
import {
  openActionsAsOwner,
  openAttendeeAsOwner,
  ownerRefunds,
} from "#test/specs/support/refund-safety/journeys.ts";
import { safetyBooking } from "#test/specs/support/refund-safety/state.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { PaymentProviderSchema } from "#types";
import {
  expectNoRefundAction,
  expectOwnerWasTold,
  refundProviderFor,
  showCompletedStripeRefund,
  untouchedChargeFor,
} from "./common.ts";

// jscpd:ignore-end

Given(
  "{word}'s old payment record does not name its provider",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await forgetStoredPaymentProvider(safetyBooking(this, who).attendeeId);
  },
);

When(
  "the owner re-saves {word}'s attendee record without changing it",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const browser = await openActionsAsOwner(this, who);
    await browser.clickLink("Edit");
    await browser.submitForm({}, "Save Attendee");
    expect(browser.pageText).toContain(`Updated ${who}`);
  },
);

When(
  "the owner opens {word}'s attendee page",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await openAttendeeAsOwner(this, who);
  },
);

Then(
  "{word}'s attendee page does not offer Refresh payment status",
  function (this: TicketsWorld, _who: string): void {
    expect(() =>
      scenarioBrowser(this).formBodyFor("Refresh payment status"),
    ).toThrow('No form found with button text "Refresh payment status"');
  },
);

Then(
  "{word}'s Actions page does not offer Refund",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await expectNoRefundAction(this, who);
  },
);

When(
  "the owner retries the refund from {word}'s Actions page",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await ownerRefunds(this, who);
  },
);

Given(
  "every payment provider is available",
  async function (this: TicketsWorld): Promise<void> {
    await refundProviderFor(this).giveCredentials(
      ...PaymentProviderSchema.options,
    );
  },
);

Given(
  "Square would recognise {word}'s Stripe payment",
  function (this: TicketsWorld, who: string): void {
    const booking = safetyBooking(this, who);
    refundProviderFor(this).show("square", booking.paymentReference, {
      resource: untouchedChargeFor(this, who),
      status: "found",
    });
  },
);

Given(
  "Stripe cannot be reached for {word}'s payment",
  function (this: TicketsWorld, who: string): void {
    const booking = safetyBooking(this, who);
    refundProviderFor(this).show("stripe", booking.paymentReference, {
      reason: "timeout",
      status: "unavailable",
    });
  },
);

When(
  "Stripe recovers for {word}'s payment",
  function (this: TicketsWorld, who: string): void {
    showCompletedStripeRefund(this, who);
  },
);

Then(
  "the owner is told the payment does not record its provider",
  function (this: TicketsWorld): void {
    expectOwnerWasTold(
      this,
      "does not record which provider took it",
      "No provider was contacted",
    );
  },
);

Then(
  "the owner is told Stripe could not answer",
  function (this: TicketsWorld): void {
    expectOwnerWasTold(this, "at stripe could not answer", "timeout");
  },
);

Then(
  "only Stripe is asked to check {word}'s payment",
  function (this: TicketsWorld, who: string): void {
    const booking = safetyBooking(this, who);
    expect(refundProviderFor(this).reads).toEqual([
      { provider: "stripe", reference: booking.paymentReference },
    ]);
  },
);

Then(
  "only Stripe was ever contacted about {word}'s payment",
  function (this: TicketsWorld, who: string): void {
    const booking = safetyBooking(this, who);
    const provider = refundProviderFor(this);
    expect(
      [...provider.reads, ...provider.sends].every(
        ({ provider: contacted, reference }) =>
          contacted === "stripe" && reference === booking.paymentReference,
      ),
    ).toBe(true);
  },
);

Then(
  "no provider is contacted about {word}'s payment",
  function (this: TicketsWorld, _who: string): void {
    const provider = refundProviderFor(this);
    expect(provider.reads).toEqual([]);
    expect(provider.sends).toEqual([]);
  },
);
