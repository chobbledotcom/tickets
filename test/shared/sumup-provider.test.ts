import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { storeSumupCheckout } from "#db/sumup-checkouts.ts";
import { PaymentUserError } from "#shared/payment-helpers.ts";
import { sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  asSession,
  BLANK_SESSION_METADATA,
} from "#test-utils/payment-session.ts";
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
        asSession({
          metadata: { ...BLANK_SESSION_METADATA, ...SUMUP_META },
          provider: "sumup",
          reason: "blank_reference",
          sessionId: "ref_blank",
        }),
      ).toThrow();
    });

    for (const { name, checkout, expected } of [
      { checkout: {}, expected: {}, name: "returns the paid checkout" },
      {
        checkout: { createdAt: "2026-06-20T09:00:00+00:00" },
        expected: { createdAt: "2026-06-20T09:00:00.000Z" },
        name: "normalises a non-canonical checkout date to canonical ISO",
      },
      {
        checkout: { createdAt: "not-a-timestamp" },
        expected: {},
        name: "keeps a paid session usable when its date cannot be read",
      },
      {
        checkout: { status: "PENDING", transactionId: "" },
        expected: { paymentReference: "", paymentStatus: "unpaid" },
        name: "maps PENDING to unpaid",
      },
      {
        checkout: { status: "FAILED", transactionId: "" },
        expected: { paymentReference: "", paymentStatus: "failed" },
        name: "maps FAILED to failed",
      },
    ] as const) {
      test(name, async () => {
        await stageSumupCheckout();
        await withFetchedSumupCheckout(sumupCheckout(checkout), async () => {
          expect(await sumupPaymentProvider.retrieveSession("ref")).toEqual({
            amountTotal: 1000,
            currency: "GBP",
            id: "ref",
            metadata: { ...BLANK_SESSION_METADATA, ...SUMUP_META },
            paymentReference: "txn",
            paymentStatus: "paid",
            provider: "sumup",
            ...expected,
          });
        });
      });
    }
  });

  describe("createCheckoutSession", () => {
    const intent = checkoutIntent({
      email: "alice@example.com",
      items: [checkoutItem({ name: "Evt", slug: "evt" })],
      name: "Alice",
    });

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

    test("returns an expected checkout message at the adapter boundary", () =>
      withMocks(
        () =>
          stub(sumupApi, "createCheckout", () =>
            Promise.reject(new PaymentUserError("Phone number is invalid")),
          ),
        async () => {
          expect(
            await sumupPaymentProvider.createCheckoutSession(
              intent,
              "http://localhost",
            ),
          ).toEqual({ error: "Phone number is invalid" });
        },
      ));

    test("propagates an unexpected checkout failure through the adapter", () => {
      const failure = new TypeError("SumUp connection failed");
      return withMocks(
        () => stub(sumupApi, "createCheckout", () => Promise.reject(failure)),
        async () => {
          await expect(
            sumupPaymentProvider.createCheckoutSession(
              intent,
              "http://localhost",
            ),
          ).rejects.toBe(failure);
        },
      );
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

    // A SumUp callback names its checkout with text. A body naming it with
    // anything else never named one, so the door refuses it rather than
    // carrying a value the session lookup would only refuse later. Each field
    // is refused on its own, so neither rule can stand in for the other.
    for (const [field, body] of [
      ["id", '{"event_type":"CHECKOUT_STATUS_CHANGED","id":0}'],
      ["event_type", '{"event_type":false,"id":"co_42"}'],
    ] as const) {
      test(`rejects a ${field} that is not text`, async () => {
        expect(await verify(body)).toEqual({
          error: "Invalid JSON payload",
          valid: false,
        });
      });
    }

    // A public unsigned door: anyone can post any JSON at all, and none of
    // these is an object carrying SumUp's two fields.
    for (const body of ["null", "123", '"text"', "true", "[]"]) {
      test(`refuses a payload that is JSON but not a callback: ${body}`, async () => {
        expect(await verify(body)).toEqual({
          error: "Invalid JSON payload",
          valid: false,
        });
      });
    }

    test("rejects an unparseable payload", async () => {
      expect(await verify("{not json")).toEqual({
        error: "Invalid JSON payload",
        valid: false,
      });
    });
  });
});
