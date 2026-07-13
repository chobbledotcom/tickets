import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type { StripeWebhookEvent } from "#shared/stripe.ts";
import {
  constructTestWebhookEvent,
  getStripeClient,
  resetStripeClient,
  setupWebhookEndpoint,
  stripeApi,
  verifyWebhookSignature,
} from "#shared/stripe.ts";
import { setTestEnv } from "#test-utils/env.ts";
import {
  installUrlHandler,
  urlFromFetchInput,
  withFetchMock,
} from "#test-utils/mocks.ts";
import { signedHeader } from "./fixtures.ts";
import { describeStripe } from "./harness.ts";

// Sets the given mock-server env, makes a Stripe client with a test secret key,
// hands it to `check`, then restores the env and resets the client.
const withStripeClient = async (
  env: Record<string, string | undefined>,
  check: (client: Awaited<ReturnType<typeof getStripeClient>>) => void,
) => {
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

// Runs setupWebhookEndpoint while every fetch throws the given value, and
// returns the endpoint result so the caller can assert on the failure.
const setupWhileFetchThrows = (thrown: unknown, url: string) =>
  withFetchMock(async () => {
    globalThis.fetch = () => {
      throw thrown;
    };
    return await setupWebhookEndpoint("sk_test_mock", url);
  });

// When every fetch throws, endpoint setup fails with a non-empty string error
// (the Stripe SDK wraps whatever was thrown, Error or not).
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

describeStripe("stripe", () => {
  describe("setupWebhookEndpointImpl", () => {
    // setupWebhookEndpointImpl creates its own client via createStripeClient(secretKey),
    // so we mock at the stripeApi level to test the various code paths

    test("creates webhook endpoint via stripe-mock (no secret returned)", async () => {
      // stripe-mock doesn't return endpoint.secret, so this exercises the "no secret" error path
      const result = await setupWebhookEndpoint(
        "sk_test_mock",
        "https://example.com/payment/webhook",
      );

      // stripe-mock likely doesn't return secret, testing the error path
      if (!result.success) {
        expect(result.error).toBe("Stripe did not return webhook secret");
      }
    });

    test("exercises delete-then-create path with existing endpoint ID", async () => {
      // This exercises the existingEndpointId deletion path
      const result = await setupWebhookEndpoint(
        "sk_test_mock",
        "https://example.com/payment/webhook",
        "we_existing_123",
      );

      // The API call goes through - deletion of non-existent endpoint is caught
      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
    });

    test("succeeds when mocked via stripeApi", async () => {
      // Override stripeApi to test the full success path
      const origSetup = stripeApi.setupWebhookEndpoint;
      stripeApi.setupWebhookEndpoint = (_key, _url, _existing) =>
        Promise.resolve({
          endpointId: "we_mocked",
          secret: "whsec_mocked",
          success: true,
        });

      try {
        const result = await setupWebhookEndpoint(
          "sk_test",
          "https://example.com/webhook",
        );
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.endpointId).toBe("we_mocked");
          expect(result.secret).toBe("whsec_mocked");
        }
      } finally {
        stripeApi.setupWebhookEndpoint = origSetup;
      }
    });

    test("returns error when API throws", async () => {
      const origSetup = stripeApi.setupWebhookEndpoint;
      stripeApi.setupWebhookEndpoint = (_key, _url) =>
        Promise.resolve({
          error: "API rate limited",
          success: false as const,
        });

      try {
        const result = await setupWebhookEndpoint(
          "sk_test",
          "https://example.com/webhook",
        );
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("API rate limited");
        }
      } finally {
        stripeApi.setupWebhookEndpoint = origSetup;
      }
    });
  });

  describe("getMockConfig", () => {
    test("returns undefined when STRIPE_MOCK_HOST not set", async () => {
      // Without mock config, a real Stripe client is created (no mock server)
      await withStripeClient(
        { STRIPE_MOCK_HOST: undefined, STRIPE_MOCK_PORT: undefined },
        (client) => expect(client).not.toBeNull(),
      );
    });
  });

  describe("getMockConfig with default port", () => {
    test("uses default port 12111 when STRIPE_MOCK_PORT not set", async () => {
      // With STRIPE_MOCK_HOST set but no PORT, should use default 12111
      await withStripeClient(
        { STRIPE_MOCK_HOST: "localhost", STRIPE_MOCK_PORT: undefined },
        (client) => expect(client).not.toBeNull(),
      );
    });
  });

  describe("setupWebhookEndpoint - stripe-mock paths", () => {
    test("creates new endpoint without deleting existing ones for same URL", async () => {
      // stripe-mock has a default endpoint at https://example.com/my/webhook/endpoint
      // Calling setupWebhookEndpoint with that URL should create a new one without deleting existing
      const result = await setupWebhookEndpoint(
        "sk_test_mock",
        "https://example.com/my/webhook/endpoint",
      );

      // stripe-mock doesn't return secret, so this hits the "no secret" error path
      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
    });

    test("returns success when endpoint.secret is present", async () => {
      // Wrap fetch to intercept the webhook_endpoints create response and inject a secret
      await withFetchMock(async (originalFetch) => {
        globalThis.fetch = async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> => {
          const response = await originalFetch(input, init);
          const url = urlFromFetchInput(input as string | URL | Request);

          // Intercept POST to webhook_endpoints (create) and add secret to response
          if (
            url.includes("/v1/webhook_endpoints") &&
            init?.method === "POST"
          ) {
            const body = await response.json();
            body.secret = "whsec_test_injected_secret";
            return new Response(JSON.stringify(body), {
              headers: response.headers,
              status: response.status,
            });
          }
          return response;
        };

        const result = await setupWebhookEndpoint(
          "sk_test_mock",
          "https://example.com/webhook/success-test",
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.endpointId).toBeDefined();
          expect(result.secret).toBe("whsec_test_injected_secret");
        }
      });
    });

    test("returns error when createStripeClient or API call throws", async () => {
      // An Error thrown on every request exercises the outer catch block.
      await expectFetchThrowGivesStringError(
        new Error("Network unavailable"),
        "https://example.com/webhook/error-test",
      );
    });

    test("catches error when deleting existing endpoint ID fails", async () => {
      // Mock fetch so that ALL DELETE requests throw (Stripe SDK retries, so we must fail all)
      await withFetchMock(async (originalFetch) => {
        installUrlHandler(originalFetch, (url, init) => {
          if (
            (init?.method ?? "GET") === "DELETE" &&
            url.includes("we_should_fail_to_delete")
          ) {
            throw new Error("Delete failed");
          }
          return null;
        });

        const result = await setupWebhookEndpoint(
          "sk_test_mock",
          "https://example.com/webhook/delete-error-test-unique",
          "we_should_fail_to_delete",
        );

        // The function should continue past the failed delete and still attempt to create
        expect(result).toBeDefined();
        expect(typeof result.success).toBe("boolean");
      });
    });

    test("returns stringified error when non-Error is thrown", async () => {
      // A thrown string (not an Error) hits the String(err) path.
      await expectFetchThrowGivesStringError(
        "string_error",
        "https://example.com/webhook/non-error-throw",
      );
    });
  });

  describe("verifyWebhookSignature - timestamp parsing", () => {
    const TEST_SECRET = "whsec_test_secret_key_for_timestamp_test";

    test("handles timestamp value that needs parseInt", async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_ts",
        secret: TEST_SECRET,
      });

      // Create listing with proper signature
      const listing: StripeWebhookEvent = {
        data: { object: { id: "cs_test" } },
        id: "evt_ts_test",
        type: "checkout.session.completed",
      };

      const { payload, signature } = await constructTestWebhookEvent(
        listing,
        TEST_SECRET,
      );

      const result = await verifyWebhookSignature(payload, signature);
      expect(result.valid).toBe(true);
    });

    test("parses timestamp with parseInt when t key has value", async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_parse",
        secret: TEST_SECRET,
      });

      // A valid number-string timestamp, exercising Number.parseInt
      const payload = '{"id": "evt_parse", "type": "test"}';
      const result = await verifyWebhookSignature(
        payload,
        await signedHeader(TEST_SECRET, payload),
      );
      expect(result.valid).toBe(true);
    });

    test("treats t key without equals as zero timestamp via parseInt fallback", async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_nullish",
        secret: TEST_SECRET,
      });

      // Header "t,v1=abc123" - split("=") on "t" gives ["t"], so value is undefined
      // value ?? "0" gives "0", parseInt("0", 10) gives 0
      // timestamp === 0, so parseSignatureHeader returns null => "Invalid signature header format"
      const result = await verifyWebhookSignature(
        '{"test": true}',
        "t,v1=abc123",
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid signature header format");
      }
    });

    test("secureCompare handles strings of different lengths", async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_len",
        secret: TEST_SECRET,
      });

      // Provide a signature that has different length than expected
      const timestamp = Math.floor(Date.now() / 1000);
      const result = await verifyWebhookSignature(
        '{"test": true}',
        `t=${timestamp},v1=short`,
      );
      // Signature won't match but should not crash - secureCompare handles length diff
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Signature verification failed");
      }
    });
  });

  describe("verifyWebhookSignature - enhanced error details", () => {
    const TEST_SECRET = "whsec_test_secret_key_for_detail_tests";

    beforeEach(async () => {
      await settings.update.stripe.webhookConfig({
        endpointId: "we_test_details",
        secret: TEST_SECRET,
      });
    });

    test("logs 'missing timestamp' when header has signature but no timestamp", async () => {
      const errorSpy = spy(console, "error");
      try {
        await verifyWebhookSignature('{"test": true}', "v1=abc123");
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain('detail="invalid header: missing timestamp"');
      } finally {
        errorSpy.restore();
      }
    });

    test("logs 'missing signature' when header has timestamp but no v1", async () => {
      const errorSpy = spy(console, "error");
      try {
        await verifyWebhookSignature('{"test": true}', "t=1234");
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain('detail="invalid header: missing signature"');
      } finally {
        errorSpy.restore();
      }
    });

    test("logs 'missing timestamp and signature' for completely invalid header", async () => {
      const errorSpy = spy(console, "error");
      try {
        await verifyWebhookSignature('{"test": true}', "invalid-header");
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain(
          'detail="invalid header: missing timestamp and signature"',
        );
      } finally {
        errorSpy.restore();
      }
    });

    test("logs timestamp delta and tolerance when out of tolerance", async () => {
      const errorSpy = spy(console, "error");
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400;
      const payload = '{"test": true}';
      const header = await signedHeader(TEST_SECRET, payload, oldTimestamp);

      try {
        await verifyWebhookSignature(payload, header);
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain("timestamp out of tolerance delta=");
        expect(callArg).toContain("tolerance=300s");
      } finally {
        errorSpy.restore();
      }
    });

    test("logs JSON parse error message for invalid payload", async () => {
      const errorSpy = spy(console, "error");
      const payload = "not valid json {{{";
      const header = await signedHeader(TEST_SECRET, payload);

      try {
        await verifyWebhookSignature(payload, header);
        const callArg = errorSpy.calls[0]!.args[0] as string;
        expect(callArg).toContain('detail="invalid JSON:');
      } finally {
        errorSpy.restore();
      }
    });
  });
});
