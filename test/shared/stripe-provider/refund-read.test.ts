import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import type { ProviderResource } from "#shared/payment-state/resources.ts";
import type { stripeApi } from "#shared/stripe.ts";
import { REFUND_RESOURCE } from "#test/shared/db/payments/fixtures.ts";
import { stripeRefund } from "#test/test-utils/stripe/fixtures.ts";
import { readStripeProvider } from "#test/test-utils/stripe/provider-fixtures.ts";

const readRefund = (
  lookup: Awaited<ReturnType<typeof stripeApi.retrieveRefund>>,
  requested: ProviderResource = REFUND_RESOURCE,
): Promise<ProviderRead> => readStripeProvider({ refund: lookup, requested });

describe("Stripe provider refund reads", () => {
  test("returns the requested refund with its exact parent and amount", async () => {
    const read = await readRefund({
      status: "found",
      value: stripeRefund({ amount: 400, status: "succeeded" }),
    });
    expect(read).toMatchObject({
      observation: {
        charges: [
          {
            refunds: [
              {
                amount: { amount: 400, currency: "GBP" },
                refund: REFUND_RESOURCE,
                status: "completed",
              },
            ],
          },
        ],
      },
      returned: REFUND_RESOURCE,
      status: "found",
    });
  });

  for (const [status, observed] of [
    ["pending", "pending"],
    ["failed", "failed"],
  ] as const) {
    test(`reports a requested ${status} refund as ${observed}`, async () => {
      const read = await readRefund({
        status: "found",
        value: stripeRefund({ amount: 400, status }),
      });
      expect(read).toMatchObject({
        observation: { charges: [{ refunds: [{ status: observed }] }] },
        status: "found",
      });
    });
  }

  test("reports a missing requested refund without inferring payment state", async () => {
    expect(await readRefund({ status: "missing" })).toMatchObject({
      requested: REFUND_RESOURCE,
      status: "missing",
    });
  });

  for (const [name, refund, reason] of [
    ["id", stripeRefund({ amount: 400, id: "re_other" }), "mismatched_id"],
    [
      "PaymentIntent parent",
      stripeRefund({ amount: 400, payment_intent: "pi_other" }),
      "mismatched_parent",
    ],
    [
      "Charge parent",
      stripeRefund({ amount: 400, charge: "ch_other" }),
      "mismatched_parent",
    ],
    [
      "currency",
      stripeRefund({ amount: 400, currency: "eur" }),
      "malformed_response",
    ],
    ["amount", stripeRefund({ amount: 401 }), "malformed_response"],
  ] as const) {
    test(`rejects a requested refund with the wrong ${name}`, async () => {
      expect(
        await readRefund({ status: "found", value: refund }),
      ).toMatchObject({ reason, status: "invalid" });
    });
  }

  test("rejects a requested refund whose stored parent is wrong", async () => {
    expect(
      await readRefund(
        { status: "missing" },
        { ...REFUND_RESOURCE, parentId: "pi_other" },
      ),
    ).toMatchObject({ reason: "mismatched_parent", status: "invalid" });
  });
});
