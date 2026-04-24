import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { settings } from "#lib/db/settings.ts";
import type { WebhookEvent } from "#lib/payments.ts";
import {
  constructTestWebhookEvent,
  getSquareClient,
  type RefundPaymentInput,
  resetSquareClient,
  retrievePayment,
  squareApi,
  verifyWebhookSignature,
} from "#lib/square.ts";
import { squarePaymentProvider } from "#lib/square-provider.ts";
import { createTestDb, resetDb, withMocks } from "#test-utils";
import { createMockClient } from "#test-utils/square-helpers.ts";

describe("square (refund, webhook, provider)", () => {
  beforeEach(async () => {
    resetSquareClient();
    await createTestDb();
  });

  afterEach(() => {
    resetSquareClient();
    resetDb();
  });

  describe("refundPayment", () => {
    test("returns false when access token not set", async () => {
      const result = await squareApi.refundPayment("pay_123");
      expect(result).toBe(false);
    });

    test("returns false when payment retrieval returns null", async () => {
      await withMocks(
        () => stub(squareApi, "retrievePayment", () => Promise.resolve(null)),
        async () => {
          const result = await squareApi.refundPayment("pay_123");
          expect(result).toBe(false);
        },
      );
    });

    test("calls SDK refund with correct amount from payment", async () => {
      const { client, paymentsGet, refundsRefundPayment } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: { amount: BigInt(4200), currency: "USD" },
              id: "pay_refund_me",
              orderId: "order_refund",
              status: "COMPLETED",
            },
          }),
        refundsRefundPayment: () =>
          Promise.resolve({
            refund: { id: "refund_123", status: "PENDING" },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.refundPayment("pay_refund_me");
          expect(result).toBe(true);

          // Verify payments.get was called to fetch amount
          expect(paymentsGet.calls[0]!.args[0]).toEqual({
            paymentId: "pay_refund_me",
          });

          // Verify refund was called with correct amount and payment ID
          const refundArgs = refundsRefundPayment.calls[0]
            ?.args[0] as RefundPaymentInput;
          expect(refundArgs.paymentId).toBe("pay_refund_me");
          expect(refundArgs.amountMoney.amount).toBe(BigInt(4200));
          expect(refundArgs.amountMoney.currency).toBe("USD");
          expect(typeof refundArgs.idempotencyKey).toBe("string");
          expect(refundArgs.idempotencyKey.length).toBeGreaterThan(0);
        },
      );
    });

    test("returns false when refund SDK call throws", async () => {
      const { client } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: { amount: BigInt(1000), currency: "GBP" },
              id: "pay_fail",
              orderId: "order_fail",
              status: "COMPLETED",
            },
          }),
        refundsRefundPayment: () =>
          Promise.reject(new Error("Square API error")),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result = await squareApi.refundPayment("pay_fail");
          expect(result).toBe(false);
        },
      );
    });
  });

  describe("verifyWebhookSignature", () => {
    const TEST_SECRET = "square_test_signature_key";
    const TEST_NOTIFICATION_URL = "https://example.com/payment/webhook";
    const toBytes = (s: string) => new TextEncoder().encode(s);

    beforeEach(async () => {
      await settings.update.square.webhookSignatureKey(TEST_SECRET);
    });

    test("returns error when webhook signature key not configured", async () => {
      await resetDb();
      await createTestDb();
      const payload = '{"test": true}';
      const result = await verifyWebhookSignature(
        payload,
        "somesig",
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Webhook signature key not configured");
      }
    });

    test("returns error for invalid signature", async () => {
      const payload = '{"test": true}';
      const result = await verifyWebhookSignature(
        payload,
        "invalidsignature",
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Signature verification failed");
      }
    });

    test("returns error for invalid JSON payload with valid signature", async () => {
      const payload = "not valid json {{{";
      // Generate correct signature for invalid JSON payload
      const encoder = new TextEncoder();
      const urlBytes = encoder.encode(TEST_NOTIFICATION_URL);
      const bodyBytes = encoder.encode(payload);
      const combined = new Uint8Array(urlBytes.length + bodyBytes.length);
      combined.set(urlBytes);
      combined.set(bodyBytes, urlBytes.length);

      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(TEST_SECRET),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, combined);
      const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

      const result = await verifyWebhookSignature(
        payload,
        sigBase64,
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Invalid JSON payload");
      }
    });

    test("verifies valid signature successfully", async () => {
      const event: WebhookEvent = {
        data: {
          object: {
            id: "pay_123",
            order_id: "order_456",
            status: "COMPLETED",
          },
        },
        id: "evt_square_123",
        type: "payment.updated",
      };

      const { payload, signature } = await constructTestWebhookEvent(
        event,
        TEST_SECRET,
        TEST_NOTIFICATION_URL,
      );

      const result = await verifyWebhookSignature(
        payload,
        signature,
        TEST_NOTIFICATION_URL,
        toBytes(payload),
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.event.id).toBe("evt_square_123");
        expect(result.event.type).toBe("payment.updated");
      }
    });
  });

  describe("constructTestWebhookEvent", () => {
    test("creates valid payload and signature pair", async () => {
      const secret = "square_test_construction";
      const notificationUrl = "https://example.com/payment/webhook";
      const event: WebhookEvent = {
        data: {
          object: {
            id: "pay_123",
            status: "COMPLETED",
          },
        },
        id: "evt_constructed",
        type: "payment.updated",
      };

      const { payload, signature } = await constructTestWebhookEvent(
        event,
        secret,
        notificationUrl,
      );

      // Verify payload is valid JSON matching input
      const parsed = JSON.parse(payload);
      expect(parsed.id).toBe("evt_constructed");
      expect(parsed.type).toBe("payment.updated");

      // Signature should be base64-encoded
      expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);

      // Signature should be verifiable with the same secret (stored in DB)
      await settings.update.square.webhookSignatureKey(secret);
      const result = await verifyWebhookSignature(
        payload,
        signature,
        notificationUrl,
        new TextEncoder().encode(payload),
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("Square REST client transport", () => {
    let originalFetch: typeof globalThis.fetch;
    type FetchHeaders = Record<string, string>;
    type FetchCall = {
      args: [
        string,
        { method?: string; headers?: FetchHeaders; body?: string },
      ];
    };
    let mockFetch: { calls: FetchCall[] };

    /** Build a mock Response with the body already available as text() */
    const jsonResponse = (data: unknown) => ({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(data)),
    });

    /** Create a mock fetch with the given implementation and assign to globalThis */
    const installMockFetch = (impl: (...args: unknown[]) => unknown) => {
      mockFetch = spy(impl) as unknown as typeof mockFetch;
      globalThis.fetch = mockFetch as unknown as typeof fetch;
    };

    beforeEach(async () => {
      originalFetch = globalThis.fetch;
      await settings.update.square.accessToken("EAAAl_rest_test");
      await settings.update.square.sandbox(true);
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("sends correct headers and snake_case body for payment link creation", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment_link: {
              long_url: "https://checkout.square.site/rest",
              order_id: "ord_rest",
              url: "https://square.link/rest",
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.checkout.paymentLinks.create({
        checkoutOptions: { redirectUrl: "https://example.com/success" },
        idempotencyKey: "idem-rest",
        order: {
          lineItems: [
            {
              basePriceMoney: { amount: BigInt(2500), currency: "GBP" },
              name: "Ticket: Show",
              note: "2 Tickets",
              quantity: "2",
            },
          ],
          locationId: "L_rest",
          metadata: { items: '[{"e":1,"q":2,"p":0}]', name: "Test" },
        },
        prePopulatedData: {
          buyerEmail: "test@test.com",
          buyerPhoneNumber: "+44123",
        },
      });

      // Response prefers long_url (checkout.square.site) over short url (square.link)
      expect(result.paymentLink!.orderId).toBe("ord_rest");
      expect(result.paymentLink!.url).toBe("https://checkout.square.site/rest");

      // Request verification
      const [url, opts] = mockFetch.calls[0]!.args;
      expect(url).toBe(
        "https://connect.squareupsandbox.com/v2/online-checkout/payment-links",
      );
      expect(opts.method).toBe("POST");
      expect(opts.headers!.Authorization).toBe("Bearer EAAAl_rest_test");
      expect(opts.headers?.["Square-Version"]).toBe("2025-01-23");

      const body = JSON.parse(opts.body!);
      expect(body.idempotency_key).toBe("idem-rest");
      expect(body.order.location_id).toBe("L_rest");
      expect(body.order.line_items[0].base_price_money.amount).toBe(2500);
      expect(body.order.line_items[0].base_price_money.currency).toBe("GBP");
      expect(body.order.metadata.items).toBe('[{"e":1,"q":2,"p":0}]');
      expect(body.checkout_options.redirect_url).toBe(
        "https://example.com/success",
      );
      expect(body.pre_populated_data.buyer_email).toBe("test@test.com");
      expect(body.pre_populated_data.buyer_phone_number).toBe("+44123");
    });

    test("falls back to short url when long_url is absent", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment_link: {
              order_id: "ord_short",
              url: "https://square.link/short",
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.checkout.paymentLinks.create({
        checkoutOptions: { redirectUrl: "https://example.com" },
        idempotencyKey: "idem-short",
        order: {
          lineItems: [
            {
              basePriceMoney: { amount: BigInt(100), currency: "USD" },
              name: "T",
              note: "T",
              quantity: "1",
            },
          ],
          locationId: "L_rest",
          metadata: {},
        },
        prePopulatedData: { buyerEmail: "a@b.com" },
      });

      expect(result.paymentLink!.orderId).toBe("ord_short");
      expect(result.paymentLink!.url).toBe("https://square.link/short");
    });

    test("omits buyer_phone_number from request when not provided", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment_link: { order_id: "ord_2", url: "https://square.link/2" },
          }),
        ),
      );

      const client = await getSquareClient();
      await client!.checkout.paymentLinks.create({
        checkoutOptions: { redirectUrl: "https://example.com" },
        idempotencyKey: "idem-2",
        order: {
          lineItems: [
            {
              basePriceMoney: { amount: BigInt(100), currency: "USD" },
              name: "T",
              note: "T",
              quantity: "1",
            },
          ],
          locationId: "L_test",
          metadata: {},
        },
        prePopulatedData: { buyerEmail: "a@b.com" },
      });

      const body = JSON.parse(mockFetch.calls[0]!.args[1].body as string);
      expect(body.pre_populated_data.buyer_phone_number).toBeUndefined();
    });

    test("returns undefined paymentLink when API returns no payment_link", async () => {
      installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      const result = await client!.checkout.paymentLinks.create({
        checkoutOptions: { redirectUrl: "https://example.com" },
        idempotencyKey: "idem-3",
        order: { lineItems: [], locationId: "L", metadata: {} },
        prePopulatedData: { buyerEmail: "a@b.com" },
      });

      expect(result.paymentLink).toBeUndefined();
    });

    test("orders.get fetches correct URL and maps response to camelCase", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            order: {
              id: "ord_100",
              metadata: { items: '[{"e":5,"q":1,"p":0}]' },
              state: "COMPLETED",
              tenders: [
                { id: "t_1", payment_id: "pay_1" },
                { id: "t_2", payment_id: null },
              ],
              total_money: { amount: 5000, currency: "USD" },
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.orders.get({ orderId: "ord_100" });

      expect(mockFetch.calls[0]!.args[0]).toBe(
        "https://connect.squareupsandbox.com/v2/orders/ord_100",
      );
      expect(result.order!.id).toBe("ord_100");
      expect(result.order!.metadata!.items).toBe('[{"e":5,"q":1,"p":0}]');
      expect(result.order?.tenders?.[0]?.paymentId).toBe("pay_1");
      expect(result.order?.tenders?.[1]?.paymentId).toBeNull();
      expect(result.order!.state).toBe("COMPLETED");
      expect(result.order!.totalMoney!.amount).toBe(BigInt(5000));
      expect(result.order!.totalMoney!.currency).toBe("USD");
    });

    test("orders.get handles missing total_money", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            order: { id: "ord_no_total", metadata: {}, state: "OPEN" },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.orders.get({ orderId: "ord_no_total" });
      expect(result.order!.id).toBe("ord_no_total");
      expect(result.order!.totalMoney).toBeUndefined();
    });

    test("orders.get returns null order when API returns none", async () => {
      installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      const result = await client!.orders.get({ orderId: "missing" });
      expect(result.order).toBeNull();
    });

    test("payments.get maps response with BigInt amounts", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment: {
              amount_money: { amount: 3000, currency: "GBP" },
              id: "pay_1",
              order_id: "ord_1",
              refunded_money: { amount: 1000, currency: "GBP" },
              status: "COMPLETED",
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.payments.get({ paymentId: "pay_1" });

      expect(mockFetch.calls[0]!.args[0]).toBe(
        "https://connect.squareupsandbox.com/v2/payments/pay_1",
      );
      expect(result.payment!.id).toBe("pay_1");
      expect(result.payment!.orderId).toBe("ord_1");
      expect(result.payment!.amountMoney!.amount).toBe(BigInt(3000));
      expect(result.payment!.refundedMoney!.amount).toBe(BigInt(1000));
    });

    test("payments.get handles missing amount_money", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment: {
              id: "pay_no_amount",
              order_id: "ord_x",
              status: "PENDING",
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.payments.get({ paymentId: "pay_no_amount" });
      expect(result.payment!.id).toBe("pay_no_amount");
      expect(result.payment!.amountMoney).toBeUndefined();
    });

    test("payments.get handles missing refunded_money", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment: {
              amount_money: { amount: 2000, currency: "USD" },
              id: "pay_2",
              order_id: "ord_2",
              status: "COMPLETED",
            },
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.payments.get({ paymentId: "pay_2" });
      expect(result.payment!.amountMoney!.amount).toBe(BigInt(2000));
      expect(result.payment!.refundedMoney).toBeUndefined();
    });

    test("payments.get returns null payment when API returns none", async () => {
      installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      const result = await client!.payments.get({ paymentId: "missing" });
      expect(result.payment).toBeNull();
    });

    test("refunds.refundPayment sends correct snake_case body", async () => {
      installMockFetch(() =>
        Promise.resolve(jsonResponse({ refund: { id: "ref_1" } })),
      );

      const client = await getSquareClient();
      await client!.refunds.refundPayment({
        amountMoney: { amount: BigInt(3000), currency: "GBP" },
        idempotencyKey: "idem-ref",
        paymentId: "pay_1",
      });

      const [url, opts] = mockFetch.calls[0]!.args;
      expect(url).toBe("https://connect.squareupsandbox.com/v2/refunds");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body!);
      expect(body.idempotency_key).toBe("idem-ref");
      expect(body.payment_id).toBe("pay_1");
      expect(body.amount_money.amount).toBe(3000);
      expect(body.amount_money.currency).toBe("GBP");
    });

    test("throws error with status code and body for HTTP errors", async () => {
      installMockFetch(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve('{"errors":[{"code":"BAD_REQUEST"}]}'),
        }),
      );

      const client = await getSquareClient();
      try {
        await client!.orders.get({ orderId: "bad" });
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toContain("Status code: 400");
        expect((err as Error).message).toContain("BAD_REQUEST");
      }
    });

    test("locations.list sends GET to /v2/locations", async () => {
      installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            locations: [
              { id: "L_1", name: "Main", status: "ACTIVE" },
              { id: "L_2", name: "Branch", status: "INACTIVE" },
            ],
          }),
        ),
      );

      const client = await getSquareClient();
      const result = await client!.locations.list();

      expect(mockFetch.calls[0]!.args[0]).toBe(
        "https://connect.squareupsandbox.com/v2/locations",
      );
      expect(result.locations).toHaveLength(2);
      expect(result.locations?.[0]?.id).toBe("L_1");
      expect(result.locations?.[0]?.name).toBe("Main");
      expect(result.locations?.[1]?.status).toBe("INACTIVE");
    });

    test("uses production URL when sandbox is disabled", async () => {
      resetSquareClient();
      await settings.update.square.sandbox(false);
      installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      await client!.orders.get({ orderId: "test" });

      expect(mockFetch.calls[0]!.args[0]).toContain("connect.squareup.com");
    });
  });

  describe("squarePaymentProvider integration", () => {
    test("retrieveSession maps COMPLETED order to paid status", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_paid",
              metadata: {
                email: "john@example.com",
                items: '[{"e":1,"q":2,"p":0}]',
                name: "John Doe",
                phone: "555-1234",
              },
              state: "COMPLETED",
              tenders: [{ id: "tender_1", paymentId: "pay_abc" }],
              totalMoney: { amount: BigInt(5000), currency: "USD" },
            },
          }),
        paymentsGet: () =>
          Promise.resolve({
            payment: { id: "pay_abc", status: "COMPLETED" },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_paid");
          expect(result).not.toBeNull();
          expect(result!.id).toBe("order_paid");
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.paymentReference).toBe("pay_abc");
          expect(result!.metadata.name).toBe("John Doe");
          expect(result!.metadata.email).toBe("john@example.com");
          expect(result!.metadata.phone).toBe("555-1234");
          expect(result!.metadata.items).toBe('[{"e":1,"q":2,"p":0}]');
        },
      );
    });

    test("retrieveSession maps OPEN order to unpaid status", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_open",
              metadata: {
                email: "john@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "John",
              },
              state: "OPEN",
              totalMoney: { amount: BigInt(1000), currency: "USD" },
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_open");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("unpaid");
          expect(result!.paymentReference).toBe("");
        },
      );
    });

    test("retrieveSession returns null for missing metadata", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_no_meta",
              state: "COMPLETED",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_no_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns null for incomplete metadata", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_bad_meta",
              metadata: { email: "john@example.com" },
              state: "COMPLETED",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_bad_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns null when order not found", async () => {
      const { client } = createMockClient({
        ordersGet: () => Promise.resolve({ order: null }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_gone");
          expect(result).toBeNull();
        },
      );
    });

    test("retrieveSession returns amountTotal from order totalMoney", async () => {
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_with_amount",
              metadata: {
                email: "total@example.com",
                items: '[{"e":5,"q":2,"p":0}]',
                name: "Total User",
              },
              state: "COMPLETED",
              tenders: [{ id: "tender_1", paymentId: "pay_total_123" }],
              totalMoney: { amount: BigInt(6000), currency: "GBP" },
            },
          }),
        paymentsGet: () =>
          Promise.resolve({
            payment: { id: "pay_total_123", status: "COMPLETED" },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_with_amount");
          expect(result).not.toBeNull();
          expect(result!.amountTotal).toBe(6000);
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.paymentReference).toBe("pay_total_123");
        },
      );
    });

    test("retrieveSession handles multi-ticket order", async () => {
      const items = JSON.stringify([
        { e: 1, q: 2 },
        { e: 2, q: 1 },
      ]);
      const { client } = createMockClient({
        ordersGet: () =>
          Promise.resolve({
            order: {
              id: "order_multi",
              metadata: {
                email: "john@example.com",
                items,
                name: "John",
              },
              state: "COMPLETED",
              tenders: [{ id: "tender_1", paymentId: "pay_multi" }],
              totalMoney: { amount: BigInt(3000), currency: "USD" },
            },
          }),
        paymentsGet: () =>
          Promise.resolve({
            payment: { id: "pay_multi", status: "COMPLETED" },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result =
            await squarePaymentProvider.retrieveSession("order_multi");
          expect(result).not.toBeNull();
          expect(result!.paymentStatus).toBe("paid");
          expect(result!.metadata.items).toBe(items);
        },
      );
    });

    test("createCheckoutSession passes through SDK results", async () => {
      const { client } = createMockClient({
        checkoutCreate: () =>
          Promise.resolve({
            paymentLink: {
              orderId: "order_prov",
              url: "https://square.link/prov",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          await settings.update.square.accessToken("EAAAl_test_123");
          await settings.update.square.locationId("L_loc_prov");
          const intent = {
            address: "",
            date: null,
            email: "john@example.com",
            items: [
              {
                eventId: 1,
                name: "Test",
                quantity: 1,
                slug: "test-event",
                unitPrice: 1000,
              },
            ],
            name: "John",
            phone: "",
            special_instructions: "",
          };

          const result = await squarePaymentProvider.createCheckoutSession(
            intent,
            "http://localhost",
          );
          expect(result).not.toBeNull();
          expect(result).toHaveProperty("sessionId");
          const success = result as { sessionId: string; checkoutUrl: string };
          expect(success.sessionId).toBe("order_prov");
          expect(success.checkoutUrl).toBe("https://square.link/prov");
        },
      );
    });

    test("createCheckoutSession passes through SDK results", async () => {
      const { client } = createMockClient({
        checkoutCreate: () =>
          Promise.resolve({
            paymentLink: {
              orderId: "order_mprov",
              url: "https://square.link/mprov",
            },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          await settings.update.square.accessToken("EAAAl_test_123");
          await settings.update.square.locationId("L_loc_prov");
          const intent = {
            address: "",
            date: null,
            email: "john@example.com",
            items: [
              {
                eventId: 1,
                name: "Event 1",
                quantity: 1,
                slug: "event-1",
                unitPrice: 1000,
              },
            ],
            name: "John",
            phone: "",
            special_instructions: "",
          };

          const result = await squarePaymentProvider.createCheckoutSession(
            intent,
            "http://localhost",
          );
          expect(result).not.toBeNull();
          expect(result).toHaveProperty("sessionId");
          const success = result as { sessionId: string; checkoutUrl: string };
          expect(success.sessionId).toBe("order_mprov");
          expect(success.checkoutUrl).toBe("https://square.link/mprov");
        },
      );
    });

    test("refundPayment delegates through SDK", async () => {
      const { client } = createMockClient({
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              amountMoney: { amount: BigInt(2000), currency: "GBP" },
              id: "pay_prov_ref",
              orderId: "order_prov_ref",
              status: "COMPLETED",
            },
          }),
        refundsRefundPayment: () =>
          Promise.resolve({
            refund: { id: "refund_prov", status: "PENDING" },
          }),
      });

      await withMocks(
        () => stub(squareApi, "getSquareClient", () => client),
        async () => {
          const result =
            await squarePaymentProvider.refundPayment("pay_prov_ref");
          expect(result).toBe(true);
        },
      );
    });

    test("verifyWebhookSignature delegates with notification URL", async () => {
      // Without a real key configured, verification should fail
      const body = '{"test": true}';
      const result = await squarePaymentProvider.verifyWebhookSignature(
        body,
        "fakesig",
        "https://example.com/payment/webhook",
        new TextEncoder().encode(body),
      );
      expect(result.valid).toBe(false);
    });
  });
});
