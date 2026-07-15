import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import {
  getStripeClient,
  resetStripeClient,
  setupWebhookEndpoint,
  stripeApi,
} from "#shared/stripe.ts";
import { setTestEnv } from "#test-utils/env.ts";
import { withFetchMock } from "#test-utils/mocks.ts";
import { describeStripe } from "./harness.ts";
import {
  newWebhookApiCalls,
  setupWithWebhookApi,
  webhookEndpointsApi,
} from "./webhook-mocks.ts";

const withStripeClient = async (
  env: Record<string, string | undefined>,
  check: (client: Awaited<ReturnType<typeof getStripeClient>>) => void,
): Promise<void> => {
  const restore = setTestEnv(env);
  try {
    resetStripeClient();
    await settings.update.stripe.secretKey("sk_test_123");
    check(await getStripeClient());
  } finally {
    restore();
    resetStripeClient();
  }
};

const setupWhileFetchThrows = (thrown: unknown, url: string) =>
  withFetchMock(async () => {
    globalThis.fetch = () => {
      throw thrown;
    };
    return await setupWebhookEndpoint("sk_test_mock", url);
  });

const expectFetchThrowGivesStringError = async (
  thrown: unknown,
  url: string,
): Promise<void> => {
  const result = await setupWhileFetchThrows(thrown, url);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(typeof result.error).toBe("string");
    expect(result.error!.length > 0).toBe(true);
  }
};

const expectFailedResultWithNoDeletes = (
  result: Awaited<ReturnType<typeof setupWebhookEndpoint>>,
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

    test("deletes old recorded endpoint on limit error, then retries", async () => {
      // When Stripe rejects the create because the account is at its webhook
      // endpoint cap, setup deletes the OLD RECORDED endpoint by ID (not
      // same-URL strays) to free a slot, then retries. Same-URL strays are
      // preserved — the main cleanup (after DB save) deletes them.
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
      // Only the recorded endpoint is deleted; strays survive.
      expect(calls.deleted).toEqual(["we_recorded"]);
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
        ["enabled_events[0]", "checkout.session.completed"],
        ["url", webhookUrl],
      ]);
    });

    test("reports a missing signing secret", async () => {
      const result = await setupWebhookEndpoint(
        "sk_test_mock",
        "https://example.com/payment/webhook",
      );

      expect(result).toEqual({
        error: "Stripe did not return webhook secret",
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
          await setupWebhookEndpoint("sk_test", "https://example.com/webhook"),
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
          await setupWebhookEndpoint("sk_test", "https://example.com/webhook"),
        ).toEqual({ error: "API rate limited", success: false });
      } finally {
        stripeApi.setupWebhookEndpoint = originalSetup;
      }
    });

    test("returns an error when Stripe requests fail", async () => {
      await expectFetchThrowGivesStringError(
        new Error("Network unavailable"),
        "https://example.com/webhook/error-test",
      );
    });

    test("returns a string error when a non-Error is thrown", async () => {
      await expectFetchThrowGivesStringError(
        "string_error",
        "https://example.com/webhook/non-error-throw",
      );
    });
  });

  describe("client configuration", () => {
    test("creates a client without mock-server configuration", async () => {
      await withStripeClient(
        { STRIPE_MOCK_HOST: undefined, STRIPE_MOCK_PORT: undefined },
        (client) => expect(client).not.toBeNull(),
      );
    });

    test("uses the default mock-server port", async () => {
      await withStripeClient(
        { STRIPE_MOCK_HOST: "localhost", STRIPE_MOCK_PORT: undefined },
        (client) => expect(client).not.toBeNull(),
      );
    });
  });

  describe("mock helper", () => {
    test("returns null for non-webhook URLs", async () => {
      const calls = newWebhookApiCalls();
      const api = webhookEndpointsApi(
        "https://example.com/payment/webhook",
        calls,
      );
      expect(await api("https://example.com/other", {})).toBeNull();
    });

    test("handles GET without init (defaults to GET method)", async () => {
      const calls = newWebhookApiCalls();
      const api = webhookEndpointsApi(
        "https://example.com/payment/webhook",
        calls,
      );
      const response = await api("https://api.stripe.com/v1/webhook_endpoints");
      const body = await response!.json();
      expect(body.data).toHaveLength(2);
    });

    test("records the created body on a successful POST", async () => {
      const calls = newWebhookApiCalls();
      const api = webhookEndpointsApi(
        "https://example.com/payment/webhook",
        calls,
      );
      const response = await api(
        "https://api.stripe.com/v1/webhook_endpoints",
        {
          body: "enabled_events[0]=checkout.session.completed&url=https://example.com/payment/webhook",
          method: "POST",
        },
      );
      const body = await response!.json();
      expect(body.id).toBe("we_new");
      expect(calls.createdBody).not.toBeNull();
      expect(calls.createdBody!.get("url")).toBe(
        "https://example.com/payment/webhook",
      );
    });

    test("handles POST without init body (defaults to empty string)", async () => {
      const calls = newWebhookApiCalls();
      const api = webhookEndpointsApi(
        "https://example.com/payment/webhook",
        calls,
      );
      const response = await api(
        "https://api.stripe.com/v1/webhook_endpoints",
        { method: "POST" },
      );
      const body = await response!.json();
      expect(body.id).toBe("we_new");
      expect(calls.createdBody).not.toBeNull();
    });
  });
});
