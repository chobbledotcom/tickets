import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { storeSumupCheckout } from "#shared/db/sumup-checkouts.ts";
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
      expect(() =>
        asSession({ provider: "sumup", reason: "blank_reference" }),
      ).toThrow();
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
            provider: "sumup",
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
