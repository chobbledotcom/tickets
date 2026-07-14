import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import {
  cleanupOldWebhookEndpoints,
  getStripeClient,
  resetStripeClient,
  setupWebhookEndpoint,
  stripeApi,
} from "#shared/stripe.ts";
import { setTestEnv } from "#test-utils/env.ts";
import { installUrlHandler, withFetchMock } from "#test-utils/mocks.ts";
import { describeStripe } from "./harness.ts";

type WebhookApiCalls = {
  createAttempts: number;
  createdBody: URLSearchParams | null;
  deleted: string[];
};

const webhookEndpointsApi = (
  webhookUrl: string,
  calls: WebhookApiCalls,
  options: {
    createFails?: boolean;
    createLimitError?: boolean;
    createThrowsMaximum?: boolean;
    createThrowsNonError?: boolean;
    deleteFails?: boolean;
    listFails?: boolean;
    recordedInListing?: boolean;
  } = {},
): ((url: string, init?: RequestInit) => Promise<Response> | null) => {
  const {
    createFails = false,
    createLimitError = false,
    createThrowsMaximum = false,
    createThrowsNonError = false,
    deleteFails = false,
    listFails = false,
    recordedInListing = false,
  } = options;
  const listed = {
    data: [
      { id: "we_stray", object: "webhook_endpoint", url: webhookUrl },
      {
        id: "we_other",
        object: "webhook_endpoint",
        url: "https://other.example/webhook",
      },
      ...(recordedInListing
        ? [{ id: "we_recorded", object: "webhook_endpoint", url: webhookUrl }]
        : []),
    ],
    has_more: false,
    object: "list",
  };
  const created = {
    id: "we_new",
    object: "webhook_endpoint",
    secret: "whsec_new",
    status: "enabled",
    url: webhookUrl,
  };

  const limitErrorResponse = Response.json(
    {
      error: {
        message: "You have reached the webhook endpoint limit",
        type: "invalid_request_error",
      },
    },
    { status: 400 },
  );
  const createErrorResponse = Response.json(
    { error: { message: "Create failed", type: "api_error" } },
    { status: 500 },
  );

  const handleCreatePost = (init?: RequestInit): Promise<Response> => {
    calls.createAttempts++;
    if (createThrowsNonError && calls.createAttempts === 1) {
      throw "not an error";
    }
    if (createThrowsMaximum && calls.createAttempts === 1) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              message: "Maximum number of webhook endpoints reached",
              type: "invalid_request_error",
            },
          },
          { status: 400 },
        ),
      );
    }
    if (createLimitError && calls.createAttempts === 1) {
      return Promise.resolve(limitErrorResponse);
    }
    if (createFails) return Promise.resolve(createErrorResponse);
    calls.createdBody = new URLSearchParams(String(init?.body ?? ""));
    return Promise.resolve(Response.json(created));
  };

  return (url, init) => {
    if (!url.includes("/v1/webhook_endpoints")) return null;
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return listFails
        ? Promise.resolve(
            Response.json(
              { error: { message: "List failed", type: "api_error" } },
              { status: 500 },
            ),
          )
        : Promise.resolve(Response.json(listed));
    }
    if (method === "DELETE") {
      if (deleteFails) throw new Error("Delete failed");
      calls.deleted.push(new URL(url).pathname.split("/").pop()!);
      return Promise.resolve(Response.json({ deleted: true }));
    }
    return handleCreatePost(init);
  };
};

const setupWithWebhookApi = (
  webhookUrl: string,
  calls: WebhookApiCalls,
  existingEndpointId?: string,
  options: {
    createFails?: boolean;
    createLimitError?: boolean;
    createThrowsMaximum?: boolean;
    createThrowsNonError?: boolean;
    deleteFails?: boolean;
    listFails?: boolean;
    recordedInListing?: boolean;
  } = {},
) =>
  withFetchMock(async (originalFetch) => {
    installUrlHandler(
      originalFetch,
      webhookEndpointsApi(webhookUrl, calls, options),
    );
    return await setupWebhookEndpoint(
      "sk_test_mock",
      webhookUrl,
      existingEndpointId,
    );
  });

const cleanupWithWebhookApi = (
  webhookUrl: string,
  calls: WebhookApiCalls,
  keepEndpointId: string,
  options: {
    deleteFails?: boolean;
    listFails?: boolean;
    recordedInListing?: boolean;
  } = {},
) =>
  withFetchMock(async (originalFetch) => {
    installUrlHandler(
      originalFetch,
      webhookEndpointsApi(webhookUrl, calls, options),
    );
    return await cleanupOldWebhookEndpoints(
      "sk_test_mock",
      webhookUrl,
      keepEndpointId,
    );
  });

const newWebhookApiCalls = (): WebhookApiCalls => ({
  createAttempts: 0,
  createdBody: null,
  deleted: [],
});

const requireCreatedBody = (calls: WebhookApiCalls): URLSearchParams => {
  if (calls.createdBody === null) {
    throw new Error("Stripe webhook endpoint was not created");
  }
  return calls.createdBody;
};

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

describeStripe("Stripe webhook setup", () => {
  describe("endpoint setup", () => {
    test("creates the new endpoint and does not delete any old ones", async () => {
      // Setup creates the new endpoint only — old endpoints are deleted later
      // by cleanupOldWebhookEndpoints AFTER the DB save, so a DB-save
      // failure leaves the old endpoint (whose secret matches the DB) alive.
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        { recordedInListing: true },
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
        { createFails: true },
      );

      expect(result).toEqual({ error: expect.any(String), success: false });
      expect(calls.deleted).toEqual([]);
    });

    test("falls back to deleting strays when create hits endpoint limit", async () => {
      // When Stripe rejects the create because the account is at its webhook
      // endpoint cap, setup deletes same-URL strays (keeping the recorded
      // endpoint intact so webhooks keep delivering if the retry also fails)
      // and retries the create.
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        { createLimitError: true },
      );

      expect(result).toEqual({
        endpointId: "we_new",
        secret: "whsec_new",
        success: true,
      });
      expect(calls.createAttempts).toBe(2);
      // Strays are deleted to free up a slot; the recorded endpoint survives.
      expect(calls.deleted.toSorted()).toEqual(["we_stray"]);
    });

    test("falls back when create error message says maximum", async () => {
      // The limit detector also matches "maximum" so it covers Stripe's
      // alternative error wording.
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        { createThrowsMaximum: true },
      );

      expect(result).toEqual({
        endpointId: "we_new",
        secret: "whsec_new",
        success: true,
      });
      expect(calls.createAttempts).toBe(2);
    });

    test("re-throws create error when non-Error is thrown", async () => {
      // A thrown non-Error isn't a limit error, so it must re-throw to the
      // outer catch and return a string error.
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        { createThrowsNonError: true },
      );

      expect(result).toEqual({ error: expect.any(String), success: false });
    });

    test("subscribes only to completed checkouts", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      await setupWithWebhookApi(webhookUrl, calls);

      expect([...requireCreatedBody(calls).entries()]).toEqual([
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

  describe("endpoint cleanup", () => {
    test("deletes old same-URL endpoints, keeping the new one", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      await cleanupWithWebhookApi(webhookUrl, calls, "we_new");

      expect(calls.deleted.toSorted()).toEqual(["we_stray"]);
    });

    test("deletes the recorded endpoint when it appears in listing", async () => {
      // The recorded endpoint normally points at the same webhook URL, so it
      // reappears in the same-URL listing alongside the strays. The recorded
      // endpoint must be deleted exactly once.
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      await cleanupWithWebhookApi(webhookUrl, calls, "we_new", {
        recordedInListing: true,
      });

      expect(calls.deleted.toSorted()).toEqual(["we_recorded", "we_stray"]);
    });

    test("continues when endpoint listing fails", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      await cleanupWithWebhookApi(webhookUrl, calls, "we_new", {
        listFails: true,
      });

      expect(calls.deleted).toEqual([]);
    });

    test("continues when a delete fails", async () => {
      // A DELETE that throws must not abort the cleanup batch.
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await cleanupWithWebhookApi(webhookUrl, calls, "we_new", {
        deleteFails: true,
      });

      expect(result).toBeUndefined();
    });

    test("swallows errors from the cleanup itself", async () => {
      // If createStripeClient or the listing throws inside cleanup, the
      // error is caught — the new endpoint is already live and the DB
      // points at it, so a cleanup failure is non-fatal.
      const result = await withFetchMock(async () => {
        globalThis.fetch = () => {
          throw new Error("Cleanup network failure");
        };
        return await cleanupOldWebhookEndpoints(
          "sk_test_mock",
          "https://example.com/payment/webhook",
          "we_new",
        );
      });

      expect(result).toBeUndefined();
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
});
