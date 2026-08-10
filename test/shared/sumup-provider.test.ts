import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { storeSumupCheckout } from "#shared/db/sumup-checkouts.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { SumupTransactionMoney } from "#shared/sumup.ts";
import { sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { asSession } from "#test-utils/payment-session.ts";
import {
  SUMUP_META,
  stageSumupCheckout,
  sumupCheckout,
  withFetchedSumupCheckout,
  withSumupCheckoutRead,
} from "#test-utils/sumup.ts";

describe("sumup-provider", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
  });

  test("declares its webhook contract", () => {
    expect(sumupPaymentProvider.checkoutCompletedEventType).toBe(
      "CHECKOUT_STATUS_CHANGED",
    );
    // SumUp does not sign its webhooks: authenticity comes from re-fetching
    // the checkout, so the router must not demand a signature.
    expect(sumupPaymentProvider.requiresWebhookSignature).toBe(false);
  });

  describe("retrieveSession", () => {
    test("returns null for an unknown reference without calling SumUp", async () => {
      expect(await sumupPaymentProvider.retrieveSession("nope")).toBeNull();
    });

    test("returns null for an orphaned row (checkout creation failed)", async () => {
      await storeSumupCheckout("ref", SUMUP_META);
      expect(await sumupPaymentProvider.retrieveSession("ref")).toBeNull();
    });

    test("returns null when the checkout cannot be fetched", async () => {
      await stageSumupCheckout();
      await withSumupCheckoutRead({ status: "missing" }, async () => {
        expect(await sumupPaymentProvider.retrieveSession("ref")).toBeNull();
      });
    });

    test("throws when SumUp cannot answer for a staged checkout", async () => {
      // A passing outage must not read as a missing payment: throwing gives
      // the browser the temporary failure page instead of "not found".
      await stageSumupCheckout();
      await withSumupCheckoutRead(
        { reason: "network_error", status: "unavailable" },
        async () => {
          await expect(
            sumupPaymentProvider.retrieveSession("ref"),
          ).rejects.toThrow("could not answer");
        },
      );
    });

    test("returns null when the checkout echoes another reference", async () => {
      // The redirect's reference opened the staging row, so a checkout
      // answering with a different reference is not this booking.
      await stageSumupCheckout();
      await withFetchedSumupCheckout(
        sumupCheckout({ reference: "someone-elses" }),
        async () => {
          expect(await sumupPaymentProvider.retrieveSession("ref")).toBeNull();
        },
      );
    });

    test("asSession refuses a null or rejected result", () => {
      expect(() => asSession(null)).toThrow();
      expect(() => asSession({ reason: "blank_reference" })).toThrow();
    });

    test("fetches by the stored SumUp id and returns the paid session", async () => {
      await stageSumupCheckout();
      await withFetchedSumupCheckout(sumupCheckout(), async (calls) => {
        const result = await sumupPaymentProvider.retrieveSession("ref");
        expect(result).toEqual(
          expect.objectContaining({
            amountTotal: 1000,
            id: "ref",
            paymentReference: "txn",
            paymentStatus: "paid",
          }),
        );
        expect(asSession(result).metadata.email).toBe("alice@example.com");
        expect(calls()).toEqual([["co_1"]]);
      });
    });

    test("normalises a non-canonical checkout date to canonical ISO", async () => {
      await stageSumupCheckout();
      await withFetchedSumupCheckout(
        sumupCheckout({ createdAt: "2026-06-20T09:00:00+00:00" }),
        async () => {
          const result = await sumupPaymentProvider.retrieveSession("ref");
          expect(asSession(result).createdAt).toBe("2026-06-20T09:00:00.000Z");
        },
      );
    });

    test("drops an unparseable checkout date", async () => {
      await stageSumupCheckout();
      await withFetchedSumupCheckout(
        sumupCheckout({ createdAt: "not-a-timestamp" }),
        async () => {
          const result = await sumupPaymentProvider.retrieveSession("ref");
          expect(asSession(result).createdAt).toBeUndefined();
        },
      );
    });

    test("maps PENDING to unpaid", async () => {
      await stageSumupCheckout();
      await withFetchedSumupCheckout(
        sumupCheckout({ status: "PENDING", transactionId: "" }),
        async () => {
          const result = await sumupPaymentProvider.retrieveSession("ref");
          expect(asSession(result).paymentStatus).toBe("unpaid");
        },
      );
    });

    test("maps FAILED to failed (declined checkout)", async () => {
      await stageSumupCheckout();
      await withFetchedSumupCheckout(
        sumupCheckout({ status: "FAILED", transactionId: "" }),
        async () => {
          const result = await sumupPaymentProvider.retrieveSession("ref");
          expect(asSession(result).paymentStatus).toBe("failed");
        },
      );
    });
  });

  describe("readChargeMoneyOrNull", () => {
    const transaction = (
      refundEvents: SumupTransactionMoney["refundEvents"],
    ): SumupTransactionMoney => ({
      amount: 10,
      currency: "GBP",
      refundEvents,
    });

    /** SumUp states money in major units, so £10.00 is 1000 pence here. */
    const readMoney = async (txn: SumupTransactionMoney | null) => {
      // A holder, not a plain let: TypeScript does not track an assignment made
      // inside the callback, so a bare variable stays narrowed to null.
      const read: { money: ChargeMoney | null } = { money: null };
      await withMocks(
        () =>
          stub(sumupApi, "readTransactionMoney", () => Promise.resolve(txn)),
        async () => {
          read.money = await sumupPaymentProvider.readChargeMoneyOrNull("txn");
        },
      );
      return read.money;
    };

    test("reads a transaction with no refund events as nothing back", async () => {
      expect(await readMoney(transaction([]))).toEqual({
        captured: { amount: 1000, currency: "GBP" },
        confirmedRefunded: { amount: 0, currency: "GBP" },
        refunds: [],
      });
    });

    // SumUp keeps no cumulative refunded total, so the events carry it all —
    // and its top-level status still reads SUCCESSFUL after a refund, which is
    // why the events, not the status, decide what has gone back.
    test("adds up the refund events rather than trusting a status", async () => {
      const money = await readMoney(
        transaction([{ amount: 4, status: "REFUNDED" }]),
      );

      expect(money?.refunds).toEqual([
        { amount: { amount: 400, currency: "GBP" }, status: "completed" },
      ]);
    });

    test("reports a refund still going as pending", async () => {
      const money = await readMoney(
        transaction([{ amount: 10, status: "PENDING" }]),
      );

      expect(money?.refunds).toEqual([
        { amount: { amount: 1000, currency: "GBP" }, status: "pending" },
      ]);
    });

    test("reports a refund SumUp could not finish as failed", async () => {
      const money = await readMoney(
        transaction([{ amount: 10, status: "FAILED" }]),
      );

      expect(money?.refunds).toEqual([
        {
          amount: { amount: 1000, currency: "GBP" },
          reason: "provider_failed",
          status: "failed",
        },
      ]);
    });

    // A refund event we cannot account for might be money already returned.
    // Dropping it would let the guard send that money a second time, and SumUp
    // has no idempotency key to catch the duplicate.
    const unreadableEvents: [
      name: string,
      events: SumupTransactionMoney["refundEvents"],
    ][] = [
      ["a status SumUp does not document", [{ amount: 4, status: "WAT" }]],
      [
        "a status that says nothing about refunds",
        [{ amount: 4, status: "PAID_OUT" }],
      ],
      ["an event naming no status", [{ amount: 4, status: undefined }]],
      [
        "an event naming no amount",
        [{ amount: undefined, status: "REFUNDED" }],
      ],
    ];

    for (const [name, events] of unreadableEvents) {
      test(`refuses the whole reading for ${name}`, async () => {
        expect(await readMoney(transaction(events))).toBeNull();
      });
    }

    test("refuses a transaction that names no amount", async () => {
      expect(
        await readMoney({
          amount: undefined,
          currency: "GBP",
          refundEvents: [],
        }),
      ).toBeNull();
    });

    test("refuses a transaction that names no currency", async () => {
      expect(
        await readMoney({ amount: 10, currency: undefined, refundEvents: [] }),
      ).toBeNull();
    });

    test("refuses a transaction it cannot read at all", async () => {
      expect(await readMoney(null)).toBeNull();
    });
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

    // A falsy non-string id/type is not the missing-field marker: `?? ""`
    // passes it through, while `|| ""` would replace it — the webhook then
    // rejects the session either way (a falsy id), but the parsed shape pins
    // the `??` behavior.
    test("passes falsy non-string id and event_type through unchanged", async () => {
      expect(await verify('{"event_type":false,"id":0}')).toEqual({
        listing: { data: { object: { id: 0 } }, id: 0, type: false },
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
