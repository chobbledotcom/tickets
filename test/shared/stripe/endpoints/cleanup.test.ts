import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { StripeClient } from "#shared/stripe/client.ts";
import { cleanupOldWebhookEndpoints } from "#shared/stripe/endpoints.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import { installUrlHandler, withFetchMock } from "#test-utils/mocks.ts";
import { describeStripe } from "#test-utils/stripe/harness.ts";
import {
  cleanupWithWebhookApi,
  newWebhookApiCalls,
} from "#test-utils/stripe/webhook-mocks.ts";

const listedEndpoint = (id: string, url: string) => ({
  enabled_events: ["checkout.session.completed"],
  id,
  status: "enabled",
  url,
});

type EndpointListPage = {
  data: ReturnType<typeof listedEndpoint>[];
  has_more: boolean;
};

// Serves one listing page per cursor and fails on a cursor it was not given,
// so a wrong or missing starting_after surfaces as a failed request.
const pagedEndpointsApi =
  (pages: ReadonlyMap<string | null, EndpointListPage>, deleted: string[]) =>
  (url: string, init?: RequestInit): Promise<Response> | null => {
    if (!url.includes("/v1/webhook_endpoints")) return null;
    if (init?.method === "DELETE") {
      const id = new URL(url).pathname.split("/").pop()!;
      deleted.push(id);
      return Promise.resolve(Response.json({ deleted: true, id }));
    }
    const cursor = new URL(url).searchParams.get("starting_after");
    const page = pages.get(cursor);
    if (page === undefined) {
      throw new Error(`Unexpected listing cursor: ${cursor}`);
    }
    return Promise.resolve(Response.json({ ...page, object: "list" }));
  };

const cleanupWithPagedApi = (
  pages: ReadonlyMap<string | null, EndpointListPage>,
  deleted: string[],
): Promise<void> =>
  withFetchMock(async (originalFetch) => {
    installUrlHandler(originalFetch, pagedEndpointsApi(pages, deleted));
    return await cleanupOldWebhookEndpoints(
      "sk_test_mock",
      "https://example.com/payment/webhook",
      "we_new",
    );
  });

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

    test("follows the listing cursor to delete strays beyond the first page", async () => {
      const webhookUrl = "https://example.com/payment/webhook";
      const deleted: string[] = [];
      // Three endpoints on page one so the cursor must be the LAST id, not
      // the second; page two only exists under that exact cursor.
      const pages = new Map<string | null, EndpointListPage>([
        [
          null,
          {
            data: [
              listedEndpoint("we_stray_page_one", webhookUrl),
              listedEndpoint("we_other", "https://other.example/webhook"),
              listedEndpoint("we_last", "https://another.example/webhook"),
            ],
            has_more: true,
          },
        ],
        [
          "we_last",
          {
            data: [listedEndpoint("we_stray_page_two", webhookUrl)],
            has_more: false,
          },
        ],
      ]);

      await cleanupWithPagedApi(pages, deleted);

      expect(deleted.toSorted()).toEqual([
        "we_stray_page_one",
        "we_stray_page_two",
      ]);
    });

    test("fails loudly when Stripe reports more endpoints but sends an empty page", async () => {
      const deleted: string[] = [];
      const pages = new Map<string | null, EndpointListPage>([
        [null, { data: [], has_more: true }],
      ]);

      await expect(cleanupWithPagedApi(pages, deleted)).rejects.toThrow(
        "empty page",
      );
      expect(deleted).toEqual([]);
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
                listedEndpoint("we_stray", webhookUrl),
                listedEndpoint("we_old_recorded", oldUrl),
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
                listedEndpoint("we_keep", webhookUrl),
                listedEndpoint("we_stale", webhookUrl),
                listedEndpoint(
                  "we_unrelated",
                  "https://another-tickets.example/payment/webhook",
                ),
              ],
              has_more: false,
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
      // Cleanup must not retry network requests: a slow retry loop would
      // stall the settings save that triggered it.
      expect(createStub.calls.map((call) => call.args)).toEqual([
        ["sk_test_key", 0],
      ]);
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
            return Promise.resolve({ data: [], has_more: false });
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
});
