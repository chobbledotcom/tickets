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
import {
  installUrlHandler,
  urlFromFetchInput,
  withFetchMock,
} from "#test-utils/mocks.ts";
import { describeStripe } from "./harness.ts";

type WebhookApiCalls = {
  createdBody: URLSearchParams | null;
  deleted: string[];
};

const webhookEndpointsApi = (
  webhookUrl: string,
  calls: WebhookApiCalls,
  listFails = false,
): ((url: string, init?: RequestInit) => Promise<Response> | null) => {
  const listed = {
    data: [
      { id: "we_stray", object: "webhook_endpoint", url: webhookUrl },
      {
        id: "we_other",
        object: "webhook_endpoint",
        url: "https://other.example/webhook",
      },
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
      calls.deleted.push(new URL(url).pathname.split("/").pop()!);
      return Promise.resolve(Response.json({ deleted: true }));
    }
    calls.createdBody = new URLSearchParams(String(init?.body ?? ""));
    return Promise.resolve(Response.json(created));
  };
};

const setupWithWebhookApi = (
  webhookUrl: string,
  calls: WebhookApiCalls,
  existingEndpointId?: string,
  listFails = false,
) =>
  withFetchMock(async (originalFetch) => {
    installUrlHandler(
      originalFetch,
      webhookEndpointsApi(webhookUrl, calls, listFails),
    );
    return await setupWebhookEndpoint(
      "sk_test_mock",
      webhookUrl,
      existingEndpointId,
    );
  });

const newWebhookApiCalls = (): WebhookApiCalls => ({
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
  describe("endpoint replacement", () => {
    test("removes the recorded endpoint and same-URL strays only", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
      );

      expect(result).toEqual({
        endpointId: "we_new",
        secret: "whsec_new",
        success: true,
      });
      expect(calls.deleted.toSorted()).toEqual(["we_recorded", "we_stray"]);
    });

    test("replaces the recorded endpoint when endpoint listing fails", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      const result = await setupWithWebhookApi(
        webhookUrl,
        calls,
        "we_recorded",
        true,
      );

      expect(result).toEqual({
        endpointId: "we_new",
        secret: "whsec_new",
        success: true,
      });
      expect(calls.deleted).toEqual(["we_recorded"]);
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
  });

  describe("setup result", () => {
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

    test("continues when the recorded endpoint cannot be deleted", async () => {
      const result = await withFetchMock(async (originalFetch) => {
        globalThis.fetch = async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> => {
          const url = urlFromFetchInput(input as string | URL | Request);
          if (
            init?.method === "DELETE" &&
            url.includes("we_should_fail_to_delete")
          ) {
            throw new Error("Delete failed");
          }
          const response = await originalFetch(input, init);
          if (init?.method !== "POST") return response;
          const body = await response.json();
          body.secret = "whsec_after_delete_failure";
          return Response.json(body, { status: response.status });
        };

        return await setupWebhookEndpoint(
          "sk_test_mock",
          "https://example.com/webhook/delete-error-test-unique",
          "we_should_fail_to_delete",
        );
      });

      expect(result.success).toBe(true);
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
});
