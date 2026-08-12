// jscpd:ignore-start
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import {
  PaymentProviderSchema,
  type PaymentProviderType,
} from "#shared/types.ts";
import { forgetStoredPaymentProvider } from "#test/specs/support/refund-safety/history.ts";
import { ownerRefunds } from "#test/specs/support/refund-safety/journeys.ts";
import { safetyBooking } from "#test/specs/support/refund-safety/state.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import {
  completedRefundFor,
  expectOwnerWasTold,
  paymentReferencesFor,
  refundProviderFor,
  returnedChargeFor,
  untouchedChargeFor,
} from "./common.ts";

// jscpd:ignore-end

const buyerName = (world: TicketsWorld): string =>
  requiredWorldValue(world.attendeeName, "the buyer's name");

type ProviderSearchAnswers = Readonly<
  Record<PaymentProviderType, ProviderRead<ChargeMoney>>
>;

/** Give every configured provider its exact answer for one historical charge. */
const prepareProviderSearch = async (
  world: TicketsWorld,
  answers: ProviderSearchAnswers,
): Promise<void> => {
  const provider = refundProviderFor(world);
  const { paymentReference } = safetyBooking(world, buyerName(world));
  await provider.giveCredentials(...PaymentProviderSchema.options);
  for (const providerName of PaymentProviderSchema.options) {
    provider.show(providerName, paymentReference, answers[providerName]);
  }
};

/** Stripe can safely refund once discovery establishes it as the only match. */
const letStripeRefund = (world: TicketsWorld, who: string): void => {
  const booking = safetyBooking(world, who);
  refundProviderFor(world).answer(
    "stripe",
    booking.paymentReference,
    completedRefundFor(world, who),
    { resource: returnedChargeFor(world, who), status: "found" },
  );
};

/** Prepare discovery whose only available match is Stripe, then allow refund. */
const prepareStripeRefund = async (
  world: TicketsWorld,
  square: ProviderRead<ChargeMoney>,
): Promise<void> => {
  const who = buyerName(world);
  await prepareProviderSearch(world, {
    square,
    stripe: {
      resource: untouchedChargeFor(world, who),
      status: "found",
    },
    sumup: { status: "missing" },
  });
  letStripeRefund(world, who);
};

Given(
  "{word}'s old payment record does not name its provider",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await forgetStoredPaymentProvider(safetyBooking(this, who).attendeeId);
  },
);

Given(
  "Stripe recognises the payment while the other providers do not",
  async function (this: TicketsWorld): Promise<void> {
    await prepareStripeRefund(this, { status: "missing" });
  },
);

Given(
  "Stripe recognises the payment while Square cannot be reached",
  async function (this: TicketsWorld): Promise<void> {
    await prepareStripeRefund(this, {
      reason: "timeout",
      status: "unavailable",
    });
  },
);

When(
  "Square recovers and confirms the payment is not theirs",
  function (this: TicketsWorld): void {
    const { paymentReference } = safetyBooking(this, buyerName(this));
    refundProviderFor(this).show("square", paymentReference, {
      status: "missing",
    });
  },
);

When(
  "the owner retries the refund from {word}'s Actions page",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await ownerRefunds(this, who);
  },
);

Given(
  "Stripe and Square both recognise the payment",
  async function (this: TicketsWorld): Promise<void> {
    const who = buyerName(this);
    const charge = untouchedChargeFor(this, who);
    await prepareProviderSearch(this, {
      square: { resource: charge, status: "found" },
      stripe: { resource: charge, status: "found" },
      sumup: { status: "missing" },
    });
  },
);

Then(
  "the owner is told the provider checks could not be completed",
  function (this: TicketsWorld): void {
    expectOwnerWasTold(
      this,
      "A configured payment provider could not answer",
      "Try this refund again",
    );
  },
);

Then(
  "the owner is told to choose which provider took the payment",
  function (this: TicketsWorld): void {
    expectOwnerWasTold(
      this,
      "More than one configured payment provider recognizes this payment",
      "Choose its provider before retrying",
    );
  },
);

Then(
  "{word}'s payment record now names Stripe",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const references = await paymentReferencesFor(this, who);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      kind: "tagged",
      provider: "stripe",
      reference: safetyBooking(this, who).paymentReference,
    });
  },
);
