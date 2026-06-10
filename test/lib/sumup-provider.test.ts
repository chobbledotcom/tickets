import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { storeSumupCheckout } from "#shared/db/sumup-checkouts.ts";
import { type SumupCheckout, sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { createTestDb, resetDb, withMocks } from "#test-utils";

/** Booking metadata with the required name + items fields. */
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

/** Run body with a sumupApi checkout-retrieval method stubbed to resolve `value`. */
const withRetrieve = (
  method: "retrieveCheckoutById" | "retrieveCheckoutByReference",
  value: SumupCheckout | null,
  body: () => Promise<void>,
) =>
  withMocks(() => stub(sumupApi, method, () => Promise.resolve(value)), body);

describe("sumup-provider", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
  });

  describe("retrieveSession", () => {
    test("returns null when the checkout is not found", () =>
      withRetrieve("retrieveCheckoutByReference", null, async () => {
        expect(await sumupPaymentProvider.retrieveSession("ref")).toBeNull();
      }));

    test("returns null when the checkout has no reference", () =>
      withRetrieve(
        "retrieveCheckoutByReference",
        checkout({ reference: "" }),
        async () => {
          expect(await sumupPaymentProvider.retrieveSession("")).toBeNull();
        },
      ));

    test("returns a paid session joined with stored metadata", async () => {
      await storeSumupCheckout("ref", META);
      await withRetrieve("retrieveCheckoutByReference", checkout(), async () => {
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
      });
    });

    test("returns an unpaid session when the checkout is PENDING", async () => {
      await storeSumupCheckout("ref", META);
      await withRetrieve(
        "retrieveCheckoutByReference",
        checkout({ status: "PENDING", transactionId: "" }),
        async () => {
          const result = await sumupPaymentProvider.retrieveSession("ref");
          expect(result!.paymentStatus).toBe("unpaid");
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
        { eventId: 1, name: "Evt", quantity: 1, slug: "evt", unitPrice: 1000 },
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
    const event = (id: string) => ({
      data: { object: { id } },
      id,
      type: "CHECKOUT_STATUS_CHANGED",
    });

    test("returns null when the event carries no id", async () => {
      expect(
        await sumupPaymentProvider.resolveWebhookSession(event("")),
      ).toBeNull();
    });

    test("returns null when the checkout cannot be fetched", () =>
      withRetrieve("retrieveCheckoutById", null, async () => {
        expect(
          await sumupPaymentProvider.resolveWebhookSession(event("co_x")),
        ).toBeNull();
      }));

    test("skips an unknown checkout (no stored metadata)", () =>
      withRetrieve(
        "retrieveCheckoutById",
        checkout({ reference: "ref_unknown" }),
        async () => {
          expect(
            await sumupPaymentProvider.resolveWebhookSession(event("co_x")),
          ).toBe("skip");
        },
      ));

    test("skips when the payment is not yet paid", async () => {
      await storeSumupCheckout("ref", META);
      await withRetrieve(
        "retrieveCheckoutById",
        checkout({ status: "PENDING", transactionId: "" }),
        async () => {
          expect(
            await sumupPaymentProvider.resolveWebhookSession(event("co_p")),
          ).toBe("skip");
        },
      );
    });

    test("fetches the checkout by event id and returns the paid session", async () => {
      await storeSumupCheckout("ref", META);
      await withMocks(
        () =>
          stub(sumupApi, "retrieveCheckoutById", () =>
            Promise.resolve(checkout()),
          ),
        async (mock) => {
          const result = await sumupPaymentProvider.resolveWebhookSession(
            event("co_ok"),
          );
          expect(result).toEqual(
            expect.objectContaining({ id: "ref", paymentReference: "txn" }),
          );
          expect(mock.calls[0]!.args).toEqual(["co_ok"]);
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
        event: {
          data: { object: { id: "co_42" } },
          id: "co_42",
          type: "CHECKOUT_STATUS_CHANGED",
        },
        valid: true,
      });
    });

    test("defaults missing fields to empty strings", async () => {
      expect(await verify("{}")).toEqual({
        event: { data: { object: { id: "" } }, id: "", type: "" },
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
