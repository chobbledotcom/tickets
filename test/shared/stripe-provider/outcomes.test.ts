import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import {
  StripeConnectionError,
  StripeProtocolError,
} from "#shared/stripe/request.ts";
import type { StripeExpandedPaymentIntent } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  stripeApiError,
  stripeChargeMoney,
  stripeClient,
} from "#test/test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test/test-utils/stripe/harness.ts";
import { withMocks } from "#test-utils/mocks.ts";

type StripeCharge = NonNullable<StripeExpandedPaymentIntent["latest_charge"]>;
const capturedCharge = (
  overrides: Partial<StripeCharge> = {},
): StripeCharge => ({
  amount_captured: 1000,
  amount_refunded: 0,
  captured: true,
  currency: "gbp",
  paid: true,
  status: "succeeded",
  ...overrides,
});

const paymentIntent = (
  overrides: Partial<StripeExpandedPaymentIntent> = {},
): StripeExpandedPaymentIntent => ({
  id: "pi_refund",
  latest_charge: capturedCharge(),
  ...overrides,
});

describeStripe("Stripe provider outcomes", () => {
  describe("readPaymentIntent", () => {
    test("names an unconfigured provider", async () => {
      expect(await stripeApi.readPaymentIntent("pi_refund")).toEqual({
        reason: "not_configured",
        status: "unavailable",
      });
    });

    test("returns the matching intent", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.paymentIntents, "retrieveWithLatestCharge", () =>
            Promise.resolve(paymentIntent()),
          ),
        async () => {
          expect(await stripeApi.readPaymentIntent("pi_refund")).toEqual({
            resource: paymentIntent(),
            status: "found",
          });
        },
      );
    });

    test("refuses an intent with a different id", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.paymentIntents, "retrieveWithLatestCharge", () =>
            Promise.resolve(paymentIntent({ id: "pi_other" })),
          ),
        async () => {
          expect(await stripeApi.readPaymentIntent("pi_refund")).toEqual({
            reason: "mismatched_id",
            status: "invalid",
          });
        },
      );
    });

    for (const [error, expected] of [
      [stripeApiError(404), { status: "missing" }],
      [stripeApiError(408), { reason: "timeout", status: "unavailable" }],
      [stripeApiError(429), { reason: "rate_limited", status: "unavailable" }],
      [stripeApiError(504), { reason: "timeout", status: "unavailable" }],
      [
        stripeApiError(500),
        { reason: "provider_error", status: "unavailable" },
      ],
      [
        new StripeConnectionError("network_error", "Connection failed"),
        { reason: "network_error", status: "unavailable" },
      ],
      [
        new StripeConnectionError("timeout", "Connection timed out"),
        { reason: "timeout", status: "unavailable" },
      ],
      [
        new StripeProtocolError("Bad answer"),
        { reason: "malformed_response", status: "invalid" },
      ],
      [new StripeProtocolError("Bad 404 answer", 404), { status: "missing" }],
    ] as const) {
      test(`classifies ${error.name}: ${JSON.stringify(expected)}`, async () => {
        const client = await stripeClient();
        await withMocks(
          () =>
            stub(client.paymentIntents, "retrieveWithLatestCharge", () =>
              Promise.reject(error),
            ),
          async () => {
            expect(await stripeApi.readPaymentIntent("pi_refund")).toEqual(
              expected,
            );
          },
        );
      });
    }

    test("lets unexpected implementation errors propagate", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.paymentIntents, "retrieveWithLatestCharge", () =>
            Promise.reject(new TypeError("broken adapter")),
          ),
        async () => {
          await expect(
            stripeApi.readPaymentIntent("pi_refund"),
          ).rejects.toThrow("broken adapter");
        },
      );
    });
  });

  describe("readCharge", () => {
    test("normalises charge money", async () => {
      using _read = stub(stripeApi, "readPaymentIntent", () =>
        Promise.resolve({ resource: paymentIntent(), status: "found" }),
      );
      expect(await stripePaymentProvider.readCharge("pi_refund")).toEqual({
        resource: stripeChargeMoney(),
        status: "found",
      });
    });

    test("keeps a partial refund amount", async () => {
      using _read = stub(stripeApi, "readPaymentIntent", () =>
        Promise.resolve({
          resource: paymentIntent({
            latest_charge: capturedCharge({ amount_refunded: 400 }),
          }),
          status: "found",
        }),
      );
      expect(await stripePaymentProvider.readCharge("pi_refund")).toEqual({
        resource: stripeChargeMoney(1000, 400),
        status: "found",
      });
    });

    test("uses the amount captured instead of the amount intended", async () => {
      using _read = stub(stripeApi, "readPaymentIntent", () =>
        Promise.resolve({
          resource: paymentIntent({
            latest_charge: capturedCharge({ amount_captured: 400 }),
          }),
          status: "found",
        }),
      );
      expect(await stripePaymentProvider.readCharge("pi_refund")).toEqual({
        resource: stripeChargeMoney(400),
        status: "found",
      });
    });

    for (const [state, latestCharge] of [
      ["uncaptured", capturedCharge({ captured: false })],
      ["unpaid", capturedCharge({ paid: false })],
      ["pending", capturedCharge({ status: "pending" })],
    ] as const) {
      test(`refuses a ${state} latest charge`, async () => {
        using _read = stub(stripeApi, "readPaymentIntent", () =>
          Promise.resolve({
            resource: paymentIntent({ latest_charge: latestCharge }),
            status: "found",
          }),
        );
        expect(await stripePaymentProvider.readCharge("pi_refund")).toEqual({
          reason: "unsupported_status",
          status: "invalid",
        });
      });
    }

    test("refuses an intent without its documented charge", async () => {
      using _read = stub(stripeApi, "readPaymentIntent", () =>
        Promise.resolve({
          resource: paymentIntent({ latest_charge: null }),
          status: "found",
        }),
      );
      expect(await stripePaymentProvider.readCharge("pi_refund")).toEqual({
        reason: "missing_documented_resource",
        status: "invalid",
      });
    });

    test("refuses malformed charge money", async () => {
      using _read = stub(stripeApi, "readPaymentIntent", () =>
        Promise.resolve({
          resource: paymentIntent({
            latest_charge: capturedCharge({ amount_captured: -1 }),
          }),
          status: "found",
        }),
      );
      expect(await stripePaymentProvider.readCharge("pi_refund")).toEqual({
        reason: "malformed_money",
        status: "invalid",
      });
    });

    for (const read of [
      { status: "missing" },
      { reason: "timeout", status: "unavailable" },
      { reason: "mismatched_id", status: "invalid" },
    ] as const satisfies ProviderRead<never>[]) {
      test(`preserves ${read.status} reads`, async () => {
        using _read = stub(stripeApi, "readPaymentIntent", () =>
          Promise.resolve(read),
        );
        expect(await stripePaymentProvider.readCharge("pi_refund")).toEqual(
          read,
        );
      });
    }
  });
});
