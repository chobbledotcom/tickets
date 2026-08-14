// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { STALE_RESERVATION_MS } from "#shared/limits.ts";
import { claimLeaseMs } from "#shared/payment/claim.ts";
import type { ProviderRefundResource } from "#shared/payment/resources.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { safetyBooking } from "#test/specs/support/refund-safety/state.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { refundObservation } from "#test-utils/payment-state.ts";
import {
  expectOwnerWasTold,
  expectProviderSendCount,
  refreshFromAttendeePage,
  refundProviderFor,
  returnedChargeFor,
  untouchedChargeFor,
} from "./common.ts";

// jscpd:ignore-end

const clocks = new WeakMap<TicketsWorld, FakeTime>();

/** Freeze one scenario's clock before its durable claim is written. */
const clockFor = (world: TicketsWorld): FakeTime => {
  const running = clocks.get(world);
  if (running !== undefined) return running;
  const clock = new FakeTime();
  clocks.set(world, clock);
  world.cleanup.add(() => {
    clock.restore();
    clocks.delete(world);
  });
  return clock;
};

/** Move beyond the minimum live-request window without rewriting any claim. */
const passClaimLease = (world: TicketsWorld): void => {
  clockFor(world).tick(claimLeaseMs(STALE_RESERVATION_MS) + 1);
};

const stripeRefundFor = (
  world: TicketsWorld,
  who: string,
): ProviderRefundResource => {
  const booking = safetyBooking(world, who);
  return {
    id: `re_${booking.sessionId}`,
    kind: "stripe_refund",
    parentId: booking.paymentReference,
    provider: "stripe",
  };
};

/** Show a later completed provider refund and let the renewed claim expire. */
const providerReportsReturned = (
  world: TicketsWorld,
  provider: PaymentProviderType,
  who: string,
  pounds: number,
): void => {
  const booking = safetyBooking(world, who);
  expect(booking.amount).toBe(Math.round(pounds * 100));
  refundProviderFor(world).showCharge(
    provider,
    booking.paymentReference,
    returnedChargeFor(world, who),
  );
  passClaimLease(world);
};

Given(
  "Stripe will accept {word}'s refund but leave it settling",
  function (this: TicketsWorld, who: string): void {
    clockFor(this);
    const booking = safetyBooking(this, who);
    const provider = refundProviderFor(this);
    const charge = untouchedChargeFor(this, who);
    const refund = stripeRefundFor(this, who);
    provider.showCharge("stripe", booking.paymentReference, charge);
    provider.answer(
      "stripe",
      booking.paymentReference,
      {
        amount: charge.captured,
        kind: "accepted",
        proof: { kind: "named_refund", refund },
      },
      {
        resource: {
          ...charge,
          refunds: [
            refundObservation({
              amount: charge.captured,
              refund,
              status: "pending",
            }),
          ],
        },
        status: "found",
      },
    );
  },
);

Then(
  "the owner is told the refund is still settling and to refresh its status",
  function (this: TicketsWorld): void {
    expectOwnerWasTold(
      this,
      "A refund for this payment is still settling",
      "Refresh payment status after it completes",
    );
  },
);

When(
  "the owner presses Refresh payment status while it is still settling",
  function (this: TicketsWorld): Promise<void> {
    return refreshFromAttendeePage(this, "Alice");
  },
);

When(
  "Stripe finishes returning {word}'s {float}",
  function (this: TicketsWorld, who: string, pounds: number): void {
    providerReportsReturned(this, "stripe", who, pounds);
  },
);

Given(
  "SumUp loses the connection after receiving {word}'s refund request",
  function (this: TicketsWorld, who: string): void {
    clockFor(this);
    const booking = safetyBooking(this, who);
    const provider = refundProviderFor(this);
    provider.showCharge(
      "sumup",
      booking.paymentReference,
      untouchedChargeFor(this, who),
    );
    provider.answer("sumup", booking.paymentReference, {
      kind: "uncertain",
      reason: "network_error",
    });
  },
);

When(
  "enough time passes for the site to check again",
  function (this: TicketsWorld): void {
    passClaimLease(this);
  },
);

When(
  "SumUp reports that {word}'s {float} has been returned",
  function (this: TicketsWorld, who: string, pounds: number): void {
    // The preceding observation renewed the inherited claim. The provider's
    // later settlement is another later operator visit.
    providerReportsReturned(this, "sumup", who, pounds);
  },
);

const STORY_PROVIDERS = [
  ["Stripe", "stripe"],
  ["SumUp", "sumup"],
] as const;

for (const [providerName, provider] of STORY_PROVIDERS) {
  Then(
    `${providerName} has received one request to return {word}'s money`,
    function (this: TicketsWorld, who: string): void {
      expectProviderSendCount(this, provider, who, 1);
    },
  );
}
