import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import type { StripeClient } from "#shared/stripe/client.ts";
import { testStripeConnection } from "#shared/stripe/endpoints.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import { describeStripe } from "#test-utils/stripe/harness.ts";

const configureOwnEndpoint = () =>
  settings.update.stripe.configure({
    secretKey: "sk_test_key",
    webhookEndpointId: "we_own",
    webhookSecret: "whsec_own",
  });

const connectionWithClient = async (
  client: StripeClient,
): Promise<Awaited<ReturnType<typeof testStripeConnection>>> => {
  const getStub = stub(stripeClientRuntime, "get", () =>
    Promise.resolve(client),
  );
  try {
    return await testStripeConnection();
  } finally {
    getStub.restore();
  }
};

describeStripe("Stripe connection health", () => {
  const endpoint = (
    overrides: Partial<{
      enabled_events: string[];
      id: string;
      status: string;
      url: string;
    }> = {},
  ) => ({
    enabled_events: ["checkout.session.completed"],
    id: "we_own",
    status: "enabled",
    url: getPaymentWebhookUrl(),
    ...overrides,
  });

  const cases = [
    {
      expected: true,
      name: "healthy stored endpoint",
      webhooks: [endpoint()],
    },
    {
      expected: false,
      name: "unrelated healthy endpoint",
      webhooks: [endpoint({ id: "we_other" })],
    },
    {
      expected: false,
      name: "disabled stored endpoint",
      webhooks: [endpoint({ status: "disabled" })],
    },
    {
      expected: false,
      name: "stored endpoint at an old URL",
      webhooks: [endpoint({ url: "https://old.example/payment/webhook" })],
    },
    {
      expected: false,
      name: "stored endpoint missing checkout events",
      webhooks: [endpoint({ enabled_events: ["payment_intent.succeeded"] })],
    },
  ];

  for (const entry of cases) {
    test(`reports ${entry.name} as ${entry.expected ? "ok" : "not ok"}`, async () => {
      await configureOwnEndpoint();
      const client = {
        balance: {
          retrieve: () => Promise.resolve({ livemode: false }),
        },
        webhookEndpoints: {
          list: () =>
            Promise.resolve({ data: entry.webhooks, has_more: false }),
        },
      } as StripeClient;

      expect((await connectionWithClient(client)).ok).toBe(entry.expected);
    });
  }

  test("reports the endpoint listing error word for word", async () => {
    await configureOwnEndpoint();
    const client = {
      balance: {
        retrieve: () => Promise.resolve({ livemode: false }),
      },
      webhookEndpoints: {
        list: () => Promise.reject(new Error("Listing failed")),
      },
    } as StripeClient;

    const result = await connectionWithClient(client);

    expect(result.webhookError).toBe("Listing failed");
    expect(result.ok).toBe(false);
  });
});
