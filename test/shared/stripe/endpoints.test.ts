import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import type { StripeClient } from "#shared/stripe/client.ts";
import {
  cleanupOldWebhookEndpoints,
  testStripeConnection,
} from "#shared/stripe/endpoints.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import { describeStripe } from "#test/test-utils/stripe/harness.ts";
import {
  cleanupWithWebhookApi,
  newWebhookApiCalls,
} from "#test/test-utils/stripe/webhook-mocks.ts";
import { installUrlHandler, withFetchMock } from "#test-utils/mocks.ts";

describeStripe("Stripe webhook cleanup", () => {
  describe("endpoint cleanup", () => {
    test("deletes old same-URL endpoints, keeping the new one", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      await cleanupWithWebhookApi(webhookUrl, calls, "we_new");

      expect(calls.deleted.toSorted()).toEqual(["we_stray"]);
    });

    test("deletes the recorded endpoint when it appears in listing", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      await cleanupWithWebhookApi(webhookUrl, calls, "we_new", {
        recordedInListing: true,
      });

      expect(calls.deleted.toSorted()).toEqual(["we_recorded", "we_stray"]);
    });

    test("surfaces endpoint listing failures", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      await expect(
        cleanupWithWebhookApi(webhookUrl, calls, "we_new", {
          listFails: true,
        }),
      ).rejects.toThrow();

      expect(calls.deleted).toEqual([]);
    });

    test("surfaces endpoint deletion failures", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const calls = newWebhookApiCalls();

      await expect(
        cleanupWithWebhookApi(webhookUrl, calls, "we_new", {
          deleteFails: true,
        }),
      ).rejects.toThrow();
      expect(calls.liveEndpointIds.has("we_stray")).toBe(true);
    });

    test("surfaces network errors from endpoint listing", async () => {
      await expect(
        withFetchMock(async () => {
          globalThis.fetch = () => {
            throw new Error("Cleanup network failure");
          };
          return await cleanupOldWebhookEndpoints(
            "sk_test_mock",
            "https://example.com/payment/webhook",
            "we_new",
          );
        }),
      ).rejects.toThrow();
    });

    test("also deletes explicit IDs for domain-move cleanup", async () => {
      // After a domain change, the old recorded endpoint is at a different URL
      // and won't appear in the same-URL listing. Pass it explicitly so it
      // gets deleted and frees quota.
      const webhookUrl = "https://new.example.com/payment/webhook";
      const calls = newWebhookApiCalls();
      const oldUrl = "https://old.example.com/payment/webhook";

      const domainMoveApi = (
        url: string,
        init?: RequestInit,
      ): Promise<Response> | null => {
        if (!url.includes("/v1/webhook_endpoints")) return null;
        const method = init?.method ?? "GET";
        if (method === "GET") {
          expect(new URL(url).searchParams.get("limit")).toBe("100");
          return Promise.resolve(
            Response.json({
              data: [
                {
                  enabled_events: ["checkout.session.completed"],
                  id: "we_stray",
                  status: "enabled",
                  url: webhookUrl,
                },
                {
                  enabled_events: ["checkout.session.completed"],
                  id: "we_old_recorded",
                  status: "enabled",
                  url: oldUrl,
                },
              ],
              has_more: false,
              object: "list",
            }),
          );
        }
        if (method === "DELETE") {
          const id = new URL(url).pathname.split("/").pop()!;
          calls.deleted.push(id);
          return Promise.resolve(Response.json({ deleted: true, id }));
        }
        return null;
      };

      await withFetchMock(async (originalFetch) => {
        installUrlHandler(originalFetch, domainMoveApi);
        return await cleanupOldWebhookEndpoints(
          "sk_test_mock",
          webhookUrl,
          "we_new",
          ["we_old_recorded"],
        );
      });

      expect(calls.deleted.toSorted()).toEqual(["we_old_recorded", "we_stray"]);
    });

    test("never deletes the kept endpoint and deletes duplicate IDs once", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const deleted: string[] = [];
      const client = {
        webhookEndpoints: {
          del: (id: string) => {
            deleted.push(id);
            return Promise.resolve({ deleted: true, id });
          },
          list: () =>
            Promise.resolve({
              data: [
                {
                  enabled_events: ["checkout.session.completed"],
                  id: "we_keep",
                  status: "enabled",
                  url: webhookUrl,
                },
                {
                  enabled_events: ["checkout.session.completed"],
                  id: "we_stale",
                  status: "enabled",
                  url: webhookUrl,
                },
                {
                  enabled_events: ["checkout.session.completed"],
                  id: "we_unrelated",
                  status: "enabled",
                  url: "https://another-tickets.example/payment/webhook",
                },
              ],
            }),
        },
      } as StripeClient;
      const createStub = stub(stripeClientRuntime, "create", () => client);

      try {
        await cleanupOldWebhookEndpoints("sk_test_key", webhookUrl, "we_keep", [
          "we_stale",
          "we_keep",
          "we_stale",
        ]);
      } finally {
        createStub.restore();
      }

      expect(deleted).toEqual(["we_stale"]);
    });

    test("deletes explicit IDs without listing an old account", async () => {
      const deleted: string[] = [];
      let listCalls = 0;
      const client = {
        webhookEndpoints: {
          del: (id: string) => {
            deleted.push(id);
            return Promise.resolve({ deleted: true, id });
          },
          list: () => {
            listCalls++;
            return Promise.resolve({ data: [] });
          },
        },
      } as unknown as StripeClient;
      const createStub = stub(stripeClientRuntime, "create", () => client);

      try {
        await cleanupOldWebhookEndpoints("sk_test_old", null, null, ["we_old"]);
      } finally {
        createStub.restore();
      }

      expect(listCalls).toBe(0);
      expect(deleted).toEqual(["we_old"]);
    });
  });

  describe("connection health", () => {
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
        await settings.update.stripe.configure(
          {
            secretKey: "sk_test_key",
            webhookEndpointId: "we_own",
            webhookSecret: "whsec_own",
          },
          "stripe",
        );
        const client = {
          balance: {
            retrieve: () => Promise.resolve({ livemode: false }),
          },
          webhookEndpoints: {
            list: () => Promise.resolve({ data: entry.webhooks }),
          },
        } as StripeClient;
        const getStub = stub(stripeClientRuntime, "get", () =>
          Promise.resolve(client),
        );

        try {
          expect((await testStripeConnection()).ok).toBe(entry.expected);
        } finally {
          getStub.restore();
        }
      });
    }
  });
});
