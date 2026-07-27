// jscpd:ignore-start -- imports
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { getPaymentCharges } from "#shared/db/payments/charges.ts";
import { settings } from "#shared/db/settings.ts";
import { getPaymentOperatorCase } from "#shared/payment-runtime/operator-context.ts";
import { squareApi } from "#shared/square.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { REFUND_RESOURCE } from "#test/shared/db/payments/fixtures.ts";
import { createLegacyAttendeePaymentCase } from "#test/shared/payment-runtime/fixtures.ts";
import {
  chooseOwnerPaymentCaseDecision,
  prepareRefundableOwnerPaymentCase,
  saveOwnerPaymentCase,
} from "#test/specs/support/owner-payment-cases.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "a payment with two charges needs the owner's decision",
  async function (this: TicketsWorld): Promise<void> {
    await prepareRefundableOwnerPaymentCase(this);
    const provider = stub(stripePaymentProvider, "refundCharge", (charge) =>
      Promise.resolve({
        amount: charge.captured,
        refund: {
          ...REFUND_RESOURCE,
          id: `spec-refund-${charge.id}`,
          parentId: charge.providerReference.id,
        },
        status: "completed" as const,
      }),
    );
    this.cleanup.push(() => provider.restore());
    this.paymentProviderCalls = () => provider.calls.length;
  },
);

When(
  "the owner chooses to refund all money still held",
  async function (this: TicketsWorld): Promise<void> {
    await chooseOwnerPaymentCaseDecision(this, "refund_remaining");
  },
);

Then(
  "both charges are fully refunded",
  async function (this: TicketsWorld): Promise<void> {
    expect(
      requiredWorldValue(this.paymentProviderCalls, "provider calls")(),
    ).toBe(2);
    expect(await getPaymentCharges("local-payment-1")).toMatchObject([
      { refunded: { amount: 1_000 } },
      { refunded: { amount: 1_000 } },
    ]);
  },
);

Given(
  "a full refund needs the owner's confirmation",
  async function (this: TicketsWorld): Promise<void> {
    await prepareRefundableOwnerPaymentCase(this);
  },
);

When(
  "the owner confirms the full refund",
  async function (this: TicketsWorld): Promise<void> {
    await chooseOwnerPaymentCaseDecision(this, "confirm_fully_refunded");
  },
);

Then(
  "every charge is recorded as fully refunded",
  async function (this: TicketsWorld): Promise<void> {
    expect(await getPaymentCharges("local-payment-1")).toMatchObject([
      { refunded: { amount: 1_000 }, refundState: "completed" },
      { refunded: { amount: 1_000 }, refundState: "completed" },
    ]);
  },
);

Given(
  "an older payment has an unclear payment service record",
  async function (this: TicketsWorld): Promise<void> {
    settings.setForTest({
      square_access_token: "square-token",
      square_location_id: "location-one",
      square_sandbox: true,
    });
    this.cleanup.push(() => settings.clearTestOverrides());
    const paymentCase = await createLegacyAttendeePaymentCase(
      "square-payment-spec",
    );
    saveOwnerPaymentCase(this, paymentCase);
    const read = stub(squareApi, "readPayment", () =>
      Promise.resolve({
        status: "found" as const,
        value: {
          amountMoney: { amount: BigInt(1_000), currency: "GBP" },
          id: "square-payment-spec",
          locationId: "location-one",
          orderId: "square-order-spec",
          status: "COMPLETED",
        },
      }),
    );
    this.cleanup.push(() => read.restore());
  },
);

When(
  "the owner assigns the configured payment service",
  async function (this: TicketsWorld): Promise<void> {
    await chooseOwnerPaymentCaseDecision(this, "assign_provider:square");
  },
);

Then(
  "the older payment is attached and resolved",
  async function (this: TicketsWorld): Promise<void> {
    const context = await getPaymentOperatorCase(
      requiredWorldValue(this.paymentCaseId, "payment case id"),
    );
    expect(context?.case).toMatchObject({
      state: "resolved",
    });
    expect(context?.charges).toMatchObject([
      { captured: { amount: 1_000 }, refunded: { amount: 0 } },
    ]);
  },
);
