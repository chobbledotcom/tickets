import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { STRIPE_API_VERSION } from "#shared/stripe/request.ts";
import { stripeApi } from "#shared/stripe.ts";
import { withEnv } from "#test-utils/env.ts";
import { withFetchMock } from "#test-utils/mocks.ts";
import { activateStripe } from "#test-utils/settings.ts";
import { describeStripe } from "#test-utils/stripe/harness.ts";
import {
  newWebhookApiCalls,
  setupWithWebhookApi,
} from "#test-utils/stripe/webhook-mocks.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

const setupWhileFetchThrows = (thrown: unknown, url: string) =>
  withVirtualBackoff(() =>
    withFetchMock(async () => {
      using _env = withEnv({
        STRIPE_MOCK_HOST: undefined,
        STRIPE_MOCK_PORT: undefined,
      });
      globalThis.fetch = () => {
        throw thrown;
      };
      return await stripeApi.setupWebhookEndpoint("sk_test_mock", url);
    }),
  );

const expectFetchFailure = async (
  thrown: unknown,
  url: string,
  expected: string,
): Promise<void> => {
  const result = await setupWhileFetchThrows(thrown, url);
  expect(result).toEqual({
    error: expected,
    success: false,
  });
};

const expectFailedResultWithNoDeletes = (
  result: Awaited<ReturnType<typeof stripeApi.setupWebhookEndpoint>>,
  calls: { deleted: string[] },
): void => {
  expect(result).toEqual({ error: expect.any(String), success: false });
  expect(calls.deleted).toEqual([]);
};

describeStripe("Stripe webhook setup", () => {
  describe("endpoint setup", () => {
    test("creates the new endpoint and does not delete any old ones", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        {
          recordedInListing: true,
        },
      );

      expect(result).toEqual({
        endpointId: "we_new",
        secret: "whsec_new",
        success: true,
      });
      expect(calls.deleted).toEqual([]);
    });

    test("does not delete on create failure", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        {
          createFails: true,
        },
      );

      expectFailedResultWithNoDeletes(result, calls);
    });

    test("deletes same-URL strays on limit error, then retries", async () => {
      // When Stripe rejects the create because the account is at its webhook
      // endpoint cap, setup may free a stale same-URL slot. It must preserve
      // the endpoint named by the current database credentials until the new
      // endpoint has been created and saved.
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        {
          createLimitError: true,
        },
      );

      expect(result).toEqual({
        endpointId: "we_new",
        secret: "whsec_new",
        success: true,
      });
      expect(calls.createAttempts).toBe(2);
      expect(calls.deleted).toEqual(["we_stray"]);
      expect(calls.liveEndpointIds.has("we_recorded")).toBe(true);
    });

    test("keeps the recorded endpoint live when the cap retry fails", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();
      await activateStripe("whsec_recorded", "we_recorded");

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        settings.stripe.webhookEndpointId,
        {
          createFails: true,
          createLimitError: true,
          recordedInListing: true,
        },
      );

      expect(result).toEqual({ error: expect.any(String), success: false });
      expect(settings.stripe.secretKey).toBe("sk_test_mock");
      expect(settings.stripe.webhookEndpointId).toBe("we_recorded");
      expect(settings.stripe.webhookSecret).toBe("whsec_recorded");
      expect(calls.deleted).toEqual(["we_stray"]);
      expect(calls.liveEndpointIds.has(settings.stripe.webhookEndpointId)).toBe(
        true,
      );
    });

    test("keeps the recorded endpoint when no stale slot can be freed", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        {
          createLimitError: true,
          recordedInListing: true,
          sameUrlStray: false,
        },
      );

      expect(result).toEqual({ error: expect.any(String), success: false });
      expect(calls.createAttempts).toBe(1);
      expect(calls.deleted).toEqual([]);
      expect(calls.liveEndpointIds.has("we_recorded")).toBe(true);
    });

    test("falls back when create error message says maximum", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        {
          createThrowsMaximum: true,
        },
      );

      expect(result).toEqual({
        endpointId: "we_new",
        secret: "whsec_new",
        success: true,
      });
      expect(calls.createAttempts).toBe(2);
    });

    test("does not delete endpoints for a non-webhook maximum error", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        { createThrowsMaximumWithoutWebhook: true },
      );

      expectFailedResultWithNoDeletes(result, calls);
      expect(calls.createAttempts).toBe(1);
    });

    test("re-throws when error is webhook but not limit or maximum", async () => {
      // A webhook error that doesn't mention "limit" or "maximum" is not a
      // cap error — it must re-throw to the outer catch and return an error.
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        {
          createThrowsWebhookOnly: true,
        },
      );

      expectFailedResultWithNoDeletes(result, calls);
    });

    test("re-throws create error when non-Error is thrown", async () => {
      // A thrown non-Error (string) propagates through fetch to the Stripe
      // SDK, which wraps it. isEndpointLimitError checks instanceof Error,
      // so a non-Error can't match the limit path — it re-throws to the
      // outer catch and returns a string error.
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        {
          createThrowsNonError: true,
        },
      );

      expectFailedResultWithNoDeletes(result, calls);
    });

    test("subscribes only to completed checkouts", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      await setupWithWebhookApi(webhookUrl, calls);

      expect([...calls.createdBody!.entries()]).toEqual([
        ["api_version", STRIPE_API_VERSION],
        ["enabled_events[0]", "checkout.session.completed"],
        ["url", webhookUrl],
      ]);
    });

    test("rejects a creation response without a signing secret", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const result = await setupWithWebhookApi(
        webhookUrl,
        newWebhookApiCalls(),
        undefined,
        { omitSecret: true },
      );

      expect(result).toEqual({
        error: "Invalid response received from the Stripe API",
        success: false,
      });
    });

    test("delegates through the stubbable API", async () => {
      const originalSetup = stripeApi.setupWebhookEndpoint;
      stripeApi.setupWebhookEndpoint = () =>
        Promise.resolve({
          endpointId: "we_mocked",
          secret: "whsec_mocked",
          success: true,
        });
      try {
        expect(
          await stripeApi.setupWebhookEndpoint(
            "sk_test",
            "https://example.com/webhook",
          ),
        ).toEqual({
          endpointId: "we_mocked",
          secret: "whsec_mocked",
          success: true,
        });
      } finally {
        stripeApi.setupWebhookEndpoint = originalSetup;
      }
    });

    test("returns the stubbable API error", async () => {
      const originalSetup = stripeApi.setupWebhookEndpoint;
      stripeApi.setupWebhookEndpoint = () =>
        Promise.resolve({ error: "API rate limited", success: false });
      try {
        expect(
          await stripeApi.setupWebhookEndpoint(
            "sk_test",
            "https://example.com/webhook",
          ),
        ).toEqual({ error: "API rate limited", success: false });
      } finally {
        stripeApi.setupWebhookEndpoint = originalSetup;
      }
    });

    test("returns an error when Stripe requests fail", async () => {
      await expectFetchFailure(
        new TypeError("Network unavailable"),
        "https://example.com/webhook/error-test",
        "Stripe could not be reached",
      );
    });

    test("preserves a non-Error implementation failure", async () => {
      await expectFetchFailure(
        "string_error",
        "https://example.com/webhook/non-error-throw",
        "string_error",
      );
    });

    test("retries a transient endpoint setup failure", async () => {
      using _env = withEnv({
        STRIPE_MOCK_HOST: undefined,
        STRIPE_MOCK_PORT: undefined,
      });
      let calls = 0;
      const result = await withFetchMock(async () => {
        globalThis.fetch = () => {
          calls++;
          return Promise.resolve(
            calls === 1
              ? Response.json(
                  {
                    error: { message: "Temporary failure", type: "api_error" },
                  },
                  { status: 500 },
                )
              : Response.json({
                  id: "we_retried",
                  secret: "whsec_retried",
                }),
          );
        };
        return await withVirtualBackoff(() =>
          stripeApi.setupWebhookEndpoint(
            "sk_test_mock",
            "https://example.com/payment/webhook",
          ),
        );
      });

      expect(result).toEqual({
        endpointId: "we_retried",
        secret: "whsec_retried",
        success: true,
      });
      expect(calls).toBe(2);
    });
  });
});
