// jscpd:ignore-start -- imports

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import * as v from "valibot";
import {
  type LegacyPaymentRuntime,
  LegacyPaymentRuntimeSchema,
} from "#shared/db/payments/legacy.ts";
import { settings } from "#shared/db/settings.ts";
import { squareApi } from "#shared/square.ts";
import { stripeApi } from "#shared/stripe.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  account,
  legacyAttendeeBlobPayment,
  legacyPayment,
  read,
  sumupTransaction,
} from "#test/shared/payment-runtime/operator-legacy-read-fixtures.ts";
import { stripePaymentIntent } from "#test/test-utils/stripe/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";

// jscpd:ignore-end

const stripeCharge = (paymentIntent: string) => {
  const charge = stripePaymentIntent().latest_charge;
  if (charge === null) throw new Error("Expected a Stripe charge");
  return { ...charge, payment_intent: paymentIntent };
};

type StripeIntentChanges = NonNullable<
  Parameters<typeof stripePaymentIntent>[0]
>;

const stubFoundStripePayment = (changes: StripeIntentChanges = {}) =>
  stub(stripeApi, "lookupPaymentIntent", (reference) =>
    Promise.resolve({
      status: "found" as const,
      value: stripePaymentIntent({
        id: reference,
        latest_charge: stripeCharge(reference),
        ...changes,
      }),
    }),
  );

const stubFoundSumupPayment = (
  changes: Parameters<typeof sumupTransaction>[1] = {},
) => {
  settings.setForTest({
    sumup_api_key: "sk_test_sumup",
    sumup_merchant_code: "merchant-one",
  });
  return stub(sumupApi, "getTransactionStatus", (reference) =>
    Promise.resolve({
      status: "found" as const,
      value: sumupTransaction(reference, changes),
    }),
  );
};

describeWithEnv("legacy payment provider reads", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("requires an older provider reference", async () => {
    const runtime = v.parse(LegacyPaymentRuntimeSchema, {
      attendeePayment: null,
      checkoutStage: {
        attendeeId: 42,
        createdAt: "2026-07-26T12:00:00.000Z",
        paymentSessionId: "legacy-session",
        provider: "stripe",
        state: "pending",
        ticketTokens: "enc:1:iv:tickets",
      },
      processedPayment: null,
      sumupCheckout: null,
    });

    await expect(
      read(
        {
          accountId: null,
          attendeeId: 42,
          id: "legacy-without-reference",
          mode: null,
          provider: null,
          revision: 1,
          runtime,
          state: "needs_action",
        },
        account("stripe"),
      ),
    ).rejects.toThrow("has no provider reference");
  });

  test("rejects an empty older provider reference", async () => {
    const runtime: LegacyPaymentRuntime = v.parse(LegacyPaymentRuntimeSchema, {
      attendeePayment: null,
      checkoutStage: null,
      processedPayment: {
        attendeeId: null,
        failureData: "",
        paymentReference: "",
        paymentSessionId: "legacy-session",
        processedAt: "2026-07-26T12:00:00.000Z",
        providerRefundedAt: "",
        ticketTokens: "",
      },
      sumupCheckout: null,
    });

    await expect(
      read(
        {
          accountId: null,
          attendeeId: null,
          id: "legacy-empty-reference",
          mode: null,
          provider: null,
          revision: 1,
          runtime,
          state: "needs_action",
        },
        account("stripe"),
      ),
    ).rejects.toThrow("has no provider reference");
  });

  test("uses the processed payment reference before the attendee reference", async () => {
    settings.setForTest({
      square_access_token: "square-token",
      square_location_id: "location-one",
      square_sandbox: true,
    });
    const attendee = await legacyPayment("attendee-reference");
    const processed = await legacyPayment("processed-reference");
    const processedReference =
      processed.runtime.attendeePayment?.paymentReference;
    if (processedReference === undefined) {
      throw new Error("Expected an encrypted processed reference");
    }
    attendee.runtime.processedPayment = {
      attendeeId: null,
      failureData: "",
      listingId: null,
      paymentReference: processedReference,
      paymentSessionId: "legacy-session",
      processedAt: "2026-07-26T12:00:00.000Z",
      providerRefundedAt: "",
      ticketTokens: "",
    };
    using provider = stub(squareApi, "readPayment", () =>
      Promise.resolve({ status: "missing" as const }),
    );

    await expect(read(attendee, account("square"))).resolves.toEqual({
      status: "missing",
    });
    expect(provider.calls[0]?.args).toEqual(["processed-reference"]);
  });

  test("sends only the attendee payment id to the provider", async () => {
    settings.setForTest({
      square_access_token: "square-token",
      square_location_id: "location-one",
      square_sandbox: true,
    });
    using provider = stub(squareApi, "readPayment", () =>
      Promise.resolve({ status: "missing" as const }),
    );

    await read(
      await legacyAttendeeBlobPayment("square-attendee-payment"),
      account("square"),
    );

    expect(provider.calls[0]?.args).toEqual(["square-attendee-payment"]);
  });

  test("rejects an attendee payment with no payment id", async () => {
    using provider = stub(squareApi, "readPayment", () =>
      Promise.resolve({ status: "missing" as const }),
    );

    await expect(
      read(await legacyAttendeeBlobPayment(""), account("square")),
    ).rejects.toThrow("has no provider reference");
    expect(provider.calls).toHaveLength(0);
  });

  for (const status of ["missing", "invalid"] as const) {
    test(`maps a Stripe ${status} read`, async () => {
      using _provider = stub(stripeApi, "lookupPaymentIntent", () =>
        Promise.resolve({ status }),
      );
      expect(
        await read(await legacyPayment("pi_legacy"), account("stripe")),
      ).toEqual({ status: status === "missing" ? "missing" : "ambiguous" });
    });
  }

  test("surfaces an unavailable Stripe read", async () => {
    using _provider = stub(stripeApi, "lookupPaymentIntent", () =>
      Promise.resolve({ status: "unavailable" as const }),
    );
    await expect(
      read(await legacyPayment("pi_legacy"), account("stripe")),
    ).rejects.toThrow("Stripe could not check the older payment");
  });

  const invalidStripeIntents = [
    { changes: { id: "other" }, name: "id" },
    { changes: { status: "processing" as const }, name: "status" },
    { changes: { latest_charge: null }, name: "charge" },
    {
      changes: {
        latest_charge: {
          ...stripeCharge("pi_legacy"),
          payment_intent: "other",
        },
      },
      name: "charge parent",
    },
    {
      changes: {
        latest_charge: {
          ...stripeCharge("pi_legacy"),
          amount_captured: 0,
        },
      },
      name: "captured amount",
    },
    {
      changes: {
        latest_charge: { ...stripeCharge("pi_legacy"), paid: false },
      },
      name: "paid status",
    },
    {
      changes: {
        latest_charge: { ...stripeCharge("pi_legacy"), captured: false },
      },
      name: "capture status",
    },
    { changes: { amount_received: 999 }, name: "received amount" },
    {
      changes: {
        latest_charge: { ...stripeCharge("pi_legacy"), livemode: true },
      },
      name: "charge mode",
    },
    {
      changes: {
        latest_charge: {
          ...stripeCharge("pi_legacy"),
          currency: "eur",
        },
      },
      name: "currency",
    },
  ];

  for (const example of invalidStripeIntents) {
    test(`rejects a Stripe payment with the wrong ${example.name}`, async () => {
      using _provider = stubFoundStripePayment(example.changes);
      expect(
        await read(await legacyPayment("pi_legacy"), account("stripe")),
      ).toEqual({ status: "ambiguous" });
    });
  }

  test("rejects a Stripe payment from another mode", async () => {
    using _provider = stubFoundStripePayment();
    expect(
      await read(await legacyPayment("pi_legacy"), account("stripe", "live")),
    ).toEqual({ status: "ambiguous" });
  });

  test("keeps exact Stripe money for a required follow-up decision", async () => {
    using _provider = stubFoundStripePayment();
    expect(
      await read(await legacyPayment("pi_legacy"), account("stripe")),
    ).toEqual({
      captured: { amount: 1_000, currency: "GBP" },
      refunded: { amount: 400, currency: "GBP" },
      status: "reviewed",
    });
  });

  test("reads exact money from a live Stripe payment", async () => {
    using _provider = stubFoundStripePayment({
      latest_charge: { ...stripeCharge("pi_live"), livemode: true },
      livemode: true,
    });
    expect(
      await read(await legacyPayment("pi_live"), account("stripe", "live")),
    ).toMatchObject({ status: "reviewed" });
  });

  test("attaches Stripe money to an authoritative older checkout", async () => {
    using _provider = stubFoundStripePayment();
    const payment = await legacyPayment("pi_legacy");
    payment.runtime = v.parse(LegacyPaymentRuntimeSchema, {
      ...payment.runtime,
      checkoutStage: {
        attendeeId: 42,
        createdAt: "2026-07-26T12:00:00.000Z",
        paymentSessionId: "cs_legacy",
        provider: "stripe",
        state: "pending",
        ticketTokens: "enc:1:iv:tickets",
      },
    });

    expect(await read(payment, account("stripe"))).toMatchObject({
      charge: { id: "pi_legacy", parentId: "cs_legacy" },
      session: { id: "cs_legacy" },
      status: "attached",
    });
  });

  test("maps a missing SumUp read", async () => {
    using _provider = stub(sumupApi, "getTransactionStatus", () =>
      Promise.resolve({ status: "missing" as const }),
    );
    expect(
      await read(await legacyPayment("sumup-read"), account("sumup")),
    ).toEqual({ status: "missing" });
  });

  test("surfaces an unavailable SumUp read", async () => {
    using _provider = stub(sumupApi, "getTransactionStatus", () =>
      Promise.resolve({ status: "unavailable" as const }),
    );
    await expect(
      read(await legacyPayment("sumup-read"), account("sumup")),
    ).rejects.toThrow("SumUp could not check the older payment");
  });

  for (const example of [
    { changes: { id: "other" }, name: "id" },
    { changes: { merchantCode: "other" }, name: "merchant" },
    { changes: { status: "FAILED" as const }, name: "status" },
  ]) {
    test(`rejects a SumUp payment with the wrong ${example.name}`, async () => {
      using _provider = stubFoundSumupPayment(example.changes);
      expect(
        await read(await legacyPayment("sumup-read"), account("sumup")),
      ).toEqual({ status: "ambiguous" });
    });
  }

  test("rejects a SumUp payment from another mode", async () => {
    using _provider = stubFoundSumupPayment();
    expect(
      await read(await legacyPayment("sumup-read"), account("sumup", "live")),
    ).toEqual({ status: "ambiguous" });
  });

  test("keeps exact SumUp money for a required follow-up decision", async () => {
    using _provider = stubFoundSumupPayment();
    expect(
      await read(await legacyPayment("sumup-read"), account("sumup")),
    ).toEqual({
      captured: { amount: 1_000, currency: "GBP" },
      refunded: { amount: 100, currency: "GBP" },
      status: "reviewed",
    });
  });

  test("attaches SumUp money to an authoritative older checkout", async () => {
    using _provider = stubFoundSumupPayment();
    const payment = await legacyPayment("sumup-read");
    payment.runtime = v.parse(LegacyPaymentRuntimeSchema, {
      ...payment.runtime,
      sumupCheckout: {
        createdAt: "2026-07-26T12:00:00.000Z",
        metadata: "enc:1:iv:metadata",
        referenceIndex: "reference-index",
        sumupId: "sumup-checkout",
        wrappedKey: "wk:1:key",
      },
    });

    expect(await read(payment, account("sumup"))).toMatchObject({
      charge: { id: "sumup-read", parentId: "sumup-checkout" },
      session: { id: "sumup-checkout" },
      status: "attached",
    });
  });
});
