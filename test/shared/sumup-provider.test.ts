import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { type SumupCheckout, sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { createTestDb, resetDb, withMocks } from "#test-utils";

/** Booking metadata as buildItemsMetadata would write it. */
const META = {
  _origin: "example.com",
  email: "alice@example.com",
  items: '[{"e":1,"q":1,"p":0}]',
  name: "Alice",
};

/** A SumUp checkout with overridable fields (defaults: paid, reference "ref"). */
const checkout = (over: Partial<SumupCheckout> = {}): SumupCheckout => ({
  amountMinor: 1000,
  reference: "ref",
  status: "PAID",
  transactionId: "txn",
  ...over,
});

/** Stage metadata for reference "ref" mapped to SumUp id "co_1". */
const stageCheckout = async (): Promise<void> => {
  await storeSumupCheckout("ref", META);
  await setSumupCheckoutId("ref", "co_1");
};

/** Run body with retrieveCheckoutById stubbed to resolve `value`. */
const withFetched = (
  value: SumupCheckout | null,
  body: (calls: () => unknown[][]) => Promise<void>,
) =>
  withMocks(
    () => stub(sumupApi, "retrieveCheckoutById", () => Promise.resolve(value)),
    (mock) => body(() => mock.calls.map((c) => c.args)),
  );

describe("sumup-provider", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
  });

  describe("retrieveSession", () => {
    test("returns null for an unknown reference without calling SumUp", async () => {
      expect(await sumupPaymentProvider.retrieveSession("nope")).toBeNull();
    });

    test("returns null for an orphaned row (checkout creation failed)", async () => {
      await storeSumupCheckout("ref", META);
      expect(await sumupPaymentProvider.retrieveSession("ref")).toBeNull();
    });

    test("returns null when the checkout cannot be fetched", async () => {
      await stageCheckout();
      await withFetched(null, async () => {
        expect(await sumupPaymentProvider.retrieveSession("ref")).toBeNull();
      });
    });

    test("fetches by the stored SumUp id and returns the paid session", async () => {
      await stageCheckout();
      await withFetched(checkout(), async (calls) => {
        const result = await sumupPaymentProvider.retrieveSession("ref");
        expect(result).toEqual(
          expect.objectContaining({
            amountTotal: 1000,
            id: "ref",
            paymentReference: "txn",
            paymentStatus: "paid",
          }),
        );
        expect(result!.metadata.email).toBe("alice@example.com");
        expect(calls()).toEqual([["co_1"]]);
      });
    });

    test("normalises a non-canonical checkout date to canonical ISO", async () => {
      await stageCheckout();
      await withFetched(
        checkout({ createdAt: "2026-06-20T09:00:00+00:00" }),
        async () => {
          const result = await sumupPaymentProvider.retrieveSession("ref");
          expect(result!.createdAt).toBe("2026-06-20T09:00:00.000Z");
        },
      );
    });

    test("drops an unparseable checkout date", async () => {
      await stageCheckout();
      await withFetched(
        checkout({ createdAt: "not-a-timestamp" }),
        async () => {
          const result = await sumupPaymentProvider.retrieveSession("ref");
          expect(result!.createdAt).toBeUndefined();
        },
      );
    });

    test("maps PENDING to unpaid", async () => {
      await stageCheckout();
      await withFetched(
        checkout({ status: "PENDING", transactionId: "" }),
        async () => {
          const result = await sumupPaymentProvider.retrieveSession("ref");
          expect(result!.paymentStatus).toBe("unpaid");
        },
      );
    });

    test("maps FAILED to failed (declined checkout)", async () => {
      await stageCheckout();
      await withFetched(
        checkout({ status: "FAILED", transactionId: "" }),
        async () => {
          const result = await sumupPaymentProvider.retrieveSession("ref");
          expect(result!.paymentStatus).toBe("failed");
        },
      );
    });
  });

  describe("isPaymentRefunded", () => {
    for (const [status, refunded] of [
      ["REFUNDED", true],
      ["SUCCESSFUL", false],
      [null, false],
    ] as const) {
      test(`returns ${refunded} when transaction status is ${status}`, () =>
        withMocks(
          () =>
            stub(sumupApi, "getTransactionStatus", () =>
              Promise.resolve(status),
            ),
          async () => {
            expect(await sumupPaymentProvider.isPaymentRefunded("txn")).toBe(
              refunded,
            );
          },
        ));
    }
  });

  describe("refundPayment", () => {
    test("delegates to refundTransaction with the payment reference", () =>
      withMocks(
        () => stub(sumupApi, "refundTransaction", () => Promise.resolve(true)),
        async (mock) => {
          expect(await sumupPaymentProvider.refundPayment("txn_9")).toBe(true);
          expect(mock.calls[0]!.args).toEqual(["txn_9"]);
        },
      ));
  });

  describe("createCheckoutSession", () => {
    const intent = {
      address: "",
      date: null,
      email: "alice@example.com",
      items: [
        {
          listingId: 1,
          name: "Evt",
          quantity: 1,
          slug: "evt",
          unitPrice: 1000,
        },
      ],
      name: "Alice",
      phone: "",
      special_instructions: "",
    };

    test("maps a created checkout to sessionId + checkoutUrl", () =>
      withMocks(
        () =>
          stub(sumupApi, "createCheckout", () =>
            Promise.resolve({
              reference: "ref_new",
              url: "https://pay.sumup.com/x",
            }),
          ),
        async () => {
          expect(
            await sumupPaymentProvider.createCheckoutSession(
              intent,
              "http://localhost",
            ),
          ).toEqual({
            checkoutUrl: "https://pay.sumup.com/x",
            sessionId: "ref_new",
          });
        },
      ));

    test("returns null when checkout creation fails", () =>
      withMocks(
        () => stub(sumupApi, "createCheckout", () => Promise.resolve(null)),
        async () => {
          expect(
            await sumupPaymentProvider.createCheckoutSession(
              intent,
              "http://localhost",
            ),
          ).toBeNull();
        },
      ));
  });

  describe("resolveWebhookSession", () => {
    const listing = (id: string) => ({
      data: { object: { id } },
      id,
      type: "CHECKOUT_STATUS_CHANGED",
    });

    test("returns null when the listing carries no id", async () => {
      expect(
        await sumupPaymentProvider.resolveWebhookSession(listing("")),
      ).toBeNull();
    });

    test("skips ids we never created without calling SumUp", async () => {
      await stageCheckout();
      await withFetched(checkout(), async (calls) => {
        expect(
          await sumupPaymentProvider.resolveWebhookSession(listing("co_spam")),
        ).toBe("skip");
        expect(calls()).toEqual([]);
      });
    });

    test("returns null when the checkout cannot be fetched", async () => {
      await stageCheckout();
      await withFetched(null, async () => {
        expect(
          await sumupPaymentProvider.resolveWebhookSession(listing("co_1")),
        ).toBeNull();
      });
    });

    test("skips when the payment is not yet paid", async () => {
      await stageCheckout();
      await withFetched(
        checkout({ status: "PENDING", transactionId: "" }),
        async () => {
          expect(
            await sumupPaymentProvider.resolveWebhookSession(listing("co_1")),
          ).toBe("skip");
        },
      );
    });

    test("fetches the checkout by listing id and returns the paid session", async () => {
      await stageCheckout();
      await withFetched(checkout(), async (calls) => {
        const result = await sumupPaymentProvider.resolveWebhookSession(
          listing("co_1"),
        );
        expect(result).toEqual(
          expect.objectContaining({ id: "ref", paymentReference: "txn" }),
        );
        expect(calls()).toEqual([["co_1"]]);
      });
    });
  });

  test("setupWebhookEndpoint is a no-op (webhooks are per-checkout)", async () => {
    const result = await sumupPaymentProvider.setupWebhookEndpoint(
      "key",
      "https://example.com/payment/webhook",
    );
    expect(result).toEqual({
      error: expect.stringContaining("SumUp"),
      success: false,
    });
  });

  describe("verifyWebhookSignature", () => {
    const verify = (payload: string) =>
      sumupPaymentProvider.verifyWebhookSignature(
        payload,
        "",
        "https://example.com/payment/webhook",
        new Uint8Array(),
      );

    test("parses the unsigned payload into the event shape", async () => {
      expect(
        await verify('{"event_type":"CHECKOUT_STATUS_CHANGED","id":"co_42"}'),
      ).toEqual({
        listing: {
          data: { object: { id: "co_42" } },
          id: "co_42",
          type: "CHECKOUT_STATUS_CHANGED",
        },
        valid: true,
      });
    });

    test("defaults missing fields to empty strings", async () => {
      expect(await verify("{}")).toEqual({
        listing: { data: { object: { id: "" } }, id: "", type: "" },
        valid: true,
      });
    });

    test("rejects an unparseable payload", async () => {
      expect(await verify("{not json")).toEqual({
        error: "Invalid JSON payload",
        valid: false,
      });
    });
  });
});
