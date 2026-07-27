import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import type { ProviderResource } from "#shared/payment-state/resources.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  CHARGE_RESOURCE,
  REFUND_RESOURCE,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { stripeCharge } from "#test/test-utils/stripe/fixtures.ts";
import {
  storedStripePayment as payment,
  stripeProviderIntent as providerIntent,
  stripeProviderSession as providerSession,
  readStripeProvider,
} from "#test/test-utils/stripe/provider-fixtures.ts";
import { withMocks } from "#test-utils/mocks.ts";

const readPayment = (
  session = providerSession(),
  intent = providerIntent(),
  requested: ProviderResource = SESSION_RESOURCE,
  storedPayment: PaymentSession | null = payment(),
): Promise<ProviderRead> =>
  readStripeProvider({
    intent,
    payment: storedPayment,
    requested,
    session,
  });

describe("Stripe provider reads", () => {
  test("reports a completed zero-value checkout without a charge", async () => {
    const stored = payment({
      bookingIntent: {
        ...payment().bookingIntent,
        items: [{ e: 1, p: 0, q: 1 }],
      },
      expected: { amount: 0, currency: "GBP" },
    });
    const read = await readPayment(
      providerSession({
        amount_total: 0,
        payment_intent: null,
        payment_status: "no_payment_required",
      }),
      providerIntent(),
      SESSION_RESOURCE,
      stored,
    );

    expect(read).toMatchObject({
      observation: {
        providerTotal: { amount: 0, currency: "GBP" },
        status: "no_payment_required",
      },
      status: "found",
    });
    if (read.status !== "found") throw new Error("Expected found checkout");
    expect(read.observation.charges).toBeUndefined();
  });

  for (const [name, changed] of [
    ["an amount on it", { amount_total: 500 }],
    ["a payment behind it", { payment_intent: "pi_unexpected" }],
    ["not finished yet", { status: "open" as const }],
  ] as const) {
    test(`refuses a checkout that needs no payment but has ${name}`, async () => {
      const zeroValue = {
        amount_total: 0,
        payment_intent: null,
        payment_status: "no_payment_required" as const,
      };
      const read = await readPayment(
        providerSession({ ...zeroValue, ...changed }),
      );

      expect(read).toMatchObject({
        reason: "malformed_response",
        status: "invalid",
      });
    });
  }

  test("reports exact provider money, mode, time, and partial refund facts", async () => {
    const read = await readPayment();

    expect(read).toMatchObject({
      observation: {
        charges: [
          {
            captured: { amount: 1_000, currency: "GBP" },
            confirmedRefunded: { amount: 400, currency: "GBP" },
            resource: CHARGE_RESOURCE,
          },
        ],
        createdAt: "1970-01-01T00:02:03.000Z",
        expected: { amount: 900, currency: "EUR" },
        mode: "test",
        providerTotal: { amount: 1_000, currency: "GBP" },
        status: "paid",
      },
      status: "found",
    });
  });

  for (const [name, session, intent, reason] of [
    [
      "amount",
      providerSession(),
      providerIntent({ amount: 999, amount_received: 999 }),
      "malformed_response",
    ],
    [
      "currency",
      providerSession(),
      providerIntent({ currency: "eur" }),
      "malformed_response",
    ],
    [
      "mode",
      providerSession(),
      providerIntent({ livemode: true }),
      "malformed_response",
    ],
    [
      "intent status",
      providerSession(),
      providerIntent({ status: "processing" }),
      "unsupported_status",
    ],
    [
      "session status",
      providerSession({ status: "open" }),
      providerIntent(),
      "unsupported_status",
    ],
    [
      "capture status",
      providerSession(),
      providerIntent({
        latest_charge: stripeCharge({
          captured: false,
          payment_intent: CHARGE_RESOURCE.id,
        }),
      }),
      "unsupported_status",
    ],
  ] as const) {
    test(`rejects a paid session with mismatched ${name}`, async () => {
      expect(await readPayment(session, intent)).toMatchObject({
        reason,
        status: "invalid",
      });
    });
  }

  test("rejects wrong session, intent, charge, and requested IDs or parents", async () => {
    const cases = [
      () => readPayment(providerSession({ id: "cs_other" })),
      () => readPayment(providerSession(), providerIntent({ id: "pi_other" })),
      () =>
        readPayment(
          providerSession(),
          providerIntent({
            latest_charge: stripeCharge({ payment_intent: "pi_other" }),
          }),
        ),
      () =>
        readPayment(providerSession(), providerIntent(), {
          ...CHARGE_RESOURCE,
          id: "pi_other",
        }),
    ];
    const reads: ProviderRead[] = [];
    for (const run of cases) reads.push(await run());

    expect(reads).toEqual([
      expect.objectContaining({ reason: "mismatched_id", status: "invalid" }),
      expect.objectContaining({ reason: "mismatched_id", status: "invalid" }),
      expect.objectContaining({
        reason: "mismatched_parent",
        status: "invalid",
      }),
      expect.objectContaining({ reason: "mismatched_id", status: "invalid" }),
    ]);
  });

  for (const status of ["missing", "unavailable", "invalid"] as const) {
    test(`reports a ${status} checkout lookup accurately`, async () => {
      await withMocks(
        () =>
          stub(stripeApi, "lookupCheckoutSession", () =>
            Promise.resolve({ status }),
          ),
        async () => {
          expect(
            await stripePaymentProvider.readPayment(
              payment(),
              SESSION_RESOURCE,
            ),
          ).toMatchObject({
            status: status === "invalid" ? "invalid" : status,
          });
        },
      );
    });
  }

  test("reports unpaid and expired Checkout Sessions without inventing a charge", async () => {
    expect(
      await readPayment(
        providerSession({
          payment_intent: null,
          payment_status: "unpaid",
          status: "open",
        }),
      ),
    ).toMatchObject({ observation: { status: "pending" }, status: "found" });
    expect(
      await readPayment(
        providerSession({
          payment_intent: null,
          payment_status: "unpaid",
          status: "expired",
        }),
      ),
    ).toMatchObject({ observation: { status: "failed" }, status: "found" });
  });

  test("rejects paid sessions missing an intent or latest charge", async () => {
    expect(
      await readPayment(providerSession({ payment_intent: null })),
    ).toMatchObject({
      reason: "missing_documented_resource",
      status: "invalid",
    });
    expect(
      await readPayment(
        providerSession(),
        providerIntent({ latest_charge: null }),
      ),
    ).toMatchObject({
      reason: "missing_documented_resource",
      status: "invalid",
    });
  });

  test("uses live mode only when every paid Stripe resource is live", async () => {
    const read = await readPayment(
      providerSession({
        livemode: true,
        metadata: { items: "[]", name: "Live buyer" },
      }),
      providerIntent({
        latest_charge: stripeCharge({
          livemode: true,
          payment_intent: CHARGE_RESOURCE.id,
        }),
        livemode: true,
      }),
    );
    expect(read).toMatchObject({
      observation: { mode: "live" },
      status: "found",
    });
  });

  test("rejects foreign, unstored, and mismatched requested resources", async () => {
    const foreign: ProviderResource = {
      id: "square-order",
      kind: "square_order",
      provider: "square",
    };
    expect(
      await readPayment(providerSession(), providerIntent(), foreign),
    ).toMatchObject({ reason: "mismatched_parent", status: "invalid" });
    expect(
      await readPayment(
        providerSession(),
        providerIntent(),
        REFUND_RESOURCE,
        payment({ session: null }),
      ),
    ).toMatchObject({
      reason: "missing_documented_resource",
      status: "invalid",
    });
    expect(
      await readPayment(
        providerSession(),
        providerIntent(),
        SESSION_RESOURCE,
        payment({ session: { ...SESSION_RESOURCE, id: "cs_stored_other" } }),
      ),
    ).toMatchObject({ reason: "mismatched_parent", status: "invalid" });
  });

  test("does not adopt a legacy session without signed metadata", async () => {
    expect(
      await readPayment(
        providerSession({ metadata: {} }),
        providerIntent(),
        SESSION_RESOURCE,
        null,
      ),
    ).toMatchObject({ reason: "malformed_response", status: "invalid" });
  });

  test("reports PaymentIntent lookup outcomes without treating them as payments", async () => {
    for (const status of ["missing", "unavailable", "invalid"] as const) {
      {
        using _session = stub(stripeApi, "lookupCheckoutSession", () =>
          Promise.resolve({
            status: "found" as const,
            value: providerSession(),
          }),
        );
        using _intent = stub(stripeApi, "lookupPaymentIntent", () =>
          Promise.resolve({ status }),
        );
        expect(
          await stripePaymentProvider.readPayment(payment(), SESSION_RESOURCE),
        ).toMatchObject({
          status: status === "invalid" ? "invalid" : status,
        });
      }
    }
  });

  test("rejects an unpaid Checkout Session requested as a charge", async () => {
    expect(
      await readPayment(
        providerSession({
          payment_intent: null,
          payment_status: "unpaid",
          status: "open",
        }),
        providerIntent(),
        CHARGE_RESOURCE,
      ),
    ).toMatchObject({
      reason: "missing_documented_resource",
      status: "invalid",
    });
  });
});
