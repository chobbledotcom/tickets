import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { cleanupOldWebhookEndpoints } from "#shared/stripe.ts";
import { describeStripe } from "#test/lib/stripe/harness.ts";
import {
  cleanupWithWebhookApi,
  newWebhookApiCalls,
} from "#test/lib/stripe/webhook-mocks.ts";
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
  });
});
