import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { storeSumupCheckout } from "#shared/db/sumup-checkouts.ts";
import { PaymentUserError } from "#shared/payment-helpers.ts";
import { sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { createTestDb, resetDb, withMocks } from "#test-utils";

/** Booking metadata with the required name + items fields. */
const META = {
  _origin: "example.com",
  email: "alice@example.com",
  items: '[{"e":1,"q":1,"p":0}]',
  name: "Alice",
};

const intent = {
  address: "",
  date: null,
  email: "alice@example.com",
  items: [
    { eventId: 1, name: "Evt", quantity: 1, slug: "evt", unitPrice: 1000 },
  ],
  name: "Alice",
  phone: "",
  special_instructions: "",
};

describe("sumup-provider", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
  });

  describe("retrieveSession", () => {
    test("returns null when the checkout is not found", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "retrieveCheckoutByReference", () =>
            Promise.resolve(null),
          ),
        async () => {
          expect(await sumupPaymentProvider.retrieveSession("ref")).toBeNull();
        },
      );
    });

    test("returns null when the checkout has no reference", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "retrieveCheckoutByReference", () =>
            Promise.resolve({
              amountMinor: 1000,
              reference: "",
              status: "PAID" as const,
              transactionId: "txn_1",
            }),
          ),
        async () => {
          expect(await sumupPaymentProvider.retrieveSession("")).toBeNull();
        },
      );
    });

    test("returns null when stored metadata is missing", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "retrieveCheckoutByReference", () =>
            Promise.resolve({
              amountMinor: 1000,
              reference: "ref_no_meta",
              status: "PAID" as const,
              transactionId: "txn_1",
            }),
          ),
        async () => {
          const result =
            await sumupPaymentProvider.retrieveSession("ref_no_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("returns a paid session when status is PAID and metadata exists", async () => {
      await storeSumupCheckout("ref_paid", META);
      await withMocks(
        () =>
          stub(sumupApi, "retrieveCheckoutByReference", () =>
            Promise.resolve({
              amountMinor: 1000,
              reference: "ref_paid",
              status: "PAID" as const,
              transactionId: "txn_paid",
            }),
          ),
        async () => {
          const result = await sumupPaymentProvider.retrieveSession("ref_paid");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.id).toBe("ref_paid");
          expect(result!.paymentReference).toBe("txn_paid");
          expect(result!.amountTotal).toBe(1000);
        },
      );
    });

    test("returns an unpaid session when status is PENDING", async () => {
      await storeSumupCheckout("ref_pending", META);
      await withMocks(
        () =>
          stub(sumupApi, "retrieveCheckoutByReference", () =>
            Promise.resolve({
              amountMinor: 1000,
              reference: "ref_pending",
              status: "PENDING" as const,
              transactionId: "",
            }),
          ),
        async () => {
          const result =
            await sumupPaymentProvider.retrieveSession("ref_pending");
          expect(result!.paymentStatus).toBe("unpaid");
        },
      );
    });
  });

  describe("isPaymentRefunded", () => {
    test("returns true when the transaction status is REFUNDED", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "getTransactionStatus", () =>
            Promise.resolve("REFUNDED"),
          ),
        async () => {
          expect(await sumupPaymentProvider.isPaymentRefunded("txn")).toBe(true);
        },
      );
    });

    test("returns false for any non-REFUNDED status", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "getTransactionStatus", () =>
            Promise.resolve("SUCCESSFUL"),
          ),
        async () => {
          expect(await sumupPaymentProvider.isPaymentRefunded("txn")).toBe(
            false,
          );
        },
      );
    });

    test("returns false when the status is unavailable", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "getTransactionStatus", () => Promise.resolve(null)),
        async () => {
          expect(await sumupPaymentProvider.isPaymentRefunded("txn")).toBe(
            false,
          );
        },
      );
    });
  });

  describe("refundPayment", () => {
    test("delegates to refundTransaction with the payment reference", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "refundTransaction", () => Promise.resolve(true)),
        async (mock) => {
          expect(await sumupPaymentProvider.refundPayment("txn_9")).toBe(true);
          expect(mock.calls[0]!.args).toEqual(["txn_9"]);
        },
      );
    });
  });

  describe("createCheckoutSession", () => {
    test("maps a created checkout to sessionId + checkoutUrl", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "createCheckout", () =>
            Promise.resolve({
              reference: "ref_new",
              url: "https://pay.sumup.com/x",
            }),
          ),
        async () => {
          const result = await sumupPaymentProvider.createCheckoutSession(
            intent,
            "http://localhost",
          );
          expect(result).toEqual({
            checkoutUrl: "https://pay.sumup.com/x",
            sessionId: "ref_new",
          });
        },
      );
    });

    test("returns null when checkout creation fails", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "createCheckout", () => Promise.resolve(null)),
        async () => {
          const result = await sumupPaymentProvider.createCheckoutSession(
            intent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });

    test("returns an error result for a PaymentUserError", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "createCheckout", () => {
            throw new PaymentUserError("Bad input");
          }),
        async () => {
          const result = await sumupPaymentProvider.createCheckoutSession(
            intent,
            "http://localhost",
          );
          expect((result as { error: string }).error).toBe("Bad input");
        },
      );
    });

    test("returns null for an unexpected error", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "createCheckout", () => {
            throw new Error("network");
          }),
        async () => {
          const result = await sumupPaymentProvider.createCheckoutSession(
            intent,
            "http://localhost",
          );
          expect(result).toBeNull();
        },
      );
    });
  });

  describe("resolveWebhookSession", () => {
    const event = (id: string) => ({
      data: { object: { id } },
      id,
      type: "CHECKOUT_STATUS_CHANGED",
    });

    test("returns null when the event carries no id", async () => {
      expect(await sumupPaymentProvider.resolveWebhookSession(event(""))).toBe(
        null,
      );
    });

    test("returns null when the checkout cannot be fetched", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "retrieveCheckoutById", () => Promise.resolve(null)),
        async () => {
          expect(
            await sumupPaymentProvider.resolveWebhookSession(event("co_x")),
          ).toBeNull();
        },
      );
    });

    test("skips when the checkout is unknown to us (no metadata)", async () => {
      await withMocks(
        () =>
          stub(sumupApi, "retrieveCheckoutById", () =>
            Promise.resolve({
              amountMinor: 1000,
              reference: "ref_unknown",
              status: "PAID" as const,
              transactionId: "txn",
            }),
          ),
        async () => {
          expect(
            await sumupPaymentProvider.resolveWebhookSession(event("co_x")),
          ).toBe("skip");
        },
      );
    });

    test("skips when the payment is not yet paid", async () => {
      await storeSumupCheckout("ref_wh_pending", META);
      await withMocks(
        () =>
          stub(sumupApi, "retrieveCheckoutById", () =>
            Promise.resolve({
              amountMinor: 1000,
              reference: "ref_wh_pending",
              status: "PENDING" as const,
              transactionId: "",
            }),
          ),
        async () => {
          expect(
            await sumupPaymentProvider.resolveWebhookSession(event("co_p")),
          ).toBe("skip");
        },
      );
    });

    test("returns the session when paid and known", async () => {
      await storeSumupCheckout("ref_wh_paid", META);
      await withMocks(
        () =>
          stub(sumupApi, "retrieveCheckoutById", () =>
            Promise.resolve({
              amountMinor: 1000,
              reference: "ref_wh_paid",
              status: "PAID" as const,
              transactionId: "txn_wh",
            }),
          ),
        async (mock) => {
          const result =
            await sumupPaymentProvider.resolveWebhookSession(event("co_ok"));
          expect(result).not.toBe("skip");
          expect(result).not.toBeNull();
          if (result && result !== "skip") {
            expect(result.id).toBe("ref_wh_paid");
            expect(result.paymentReference).toBe("txn_wh");
          }
          expect(mock.calls[0]!.args).toEqual(["co_ok"]);
        },
      );
    });
  });

  describe("setupWebhookEndpoint", () => {
    test("is a no-op that reports no manual setup is needed", async () => {
      const result = await sumupPaymentProvider.setupWebhookEndpoint(
        "key",
        "https://example.com/payment/webhook",
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("SumUp");
      }
    });
  });

  describe("verifyWebhookSignature", () => {
    test("parses a valid payload into the event shape (no signature check)", async () => {
      const result = await sumupPaymentProvider.verifyWebhookSignature(
        '{"event_type":"CHECKOUT_STATUS_CHANGED","id":"co_42"}',
        "",
        "https://example.com/payment/webhook",
        new Uint8Array(),
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.event.id).toBe("co_42");
        expect(result.event.type).toBe("CHECKOUT_STATUS_CHANGED");
        expect(result.event.data.object).toEqual({ id: "co_42" });
      }
    });

    test("defaults missing fields to empty strings", async () => {
      const result = await sumupPaymentProvider.verifyWebhookSignature(
        "{}",
        "",
        "https://example.com/payment/webhook",
        new Uint8Array(),
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.event.id).toBe("");
        expect(result.event.type).toBe("");
      }
    });

    test("rejects an unparseable payload", async () => {
      const result = await sumupPaymentProvider.verifyWebhookSignature(
        "{not json",
        "",
        "https://example.com/payment/webhook",
        new Uint8Array(),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid JSON payload");
      }
    });
  });
});
