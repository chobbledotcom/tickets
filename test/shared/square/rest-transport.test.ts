import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { getSquareClient, resetSquareClient } from "#shared/square.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import {
  type FetchCall,
  installMockFetch,
  jsonResponse,
} from "#test/lib/square/mock-fetch.ts";

describeSquare(() => {
  describe("Square REST client transport", () => {
    let originalFetch: typeof globalThis.fetch;
    let mockFetch: { calls: FetchCall[] };

    beforeEach(async () => {
      originalFetch = globalThis.fetch;
      await settings.update.square.accessToken("EAAAl_rest_test");
      await settings.update.square.sandbox(true);
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("sends correct headers and snake_case body for payment link creation", async () => {
      mockFetch = installMockFetch(() =>
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

    test("keeps an empty long_url instead of falling back to short url", async () => {
      mockFetch = installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            payment_link: {
              long_url: "",
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
      expect(result.paymentLink!.url).toBe("");
    });

    test("omits buyer_phone_number from request when not provided", async () => {
      mockFetch = installMockFetch(() =>
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
      mockFetch = installMockFetch(() => Promise.resolve(jsonResponse({})));

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
      mockFetch = installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            order: {
              id: "ord_100",
              metadata: { items: '[{"e":5,"q":1,"p":0}]' },
              state: "COMPLETED",
              tenders: [
                { id: "t_1", payment_id: "pay_1" },
                { id: "t_2", payment_id: "pay_fallback", paymentId: "" },
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
      expect(result.order?.tenders?.[1]?.paymentId).toBe("");
      expect(result.order!.state).toBe("COMPLETED");
      expect(result.order!.totalMoney!.amount).toBe(BigInt(5000));
      expect(result.order!.totalMoney!.currency).toBe("USD");
    });

    test("orders.get handles missing total_money", async () => {
      mockFetch = installMockFetch(() =>
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
      mockFetch = installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      const result = await client!.orders.get({ orderId: "missing" });
      expect(result.order).toBeNull();
    });

    test("payments.get maps response with BigInt amounts", async () => {
      mockFetch = installMockFetch(() =>
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
      mockFetch = installMockFetch(() =>
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
      mockFetch = installMockFetch(() =>
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
      mockFetch = installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      const result = await client!.payments.get({ paymentId: "missing" });
      expect(result.payment).toBeNull();
    });

    test("throws error with status code and body for HTTP errors", async () => {
      mockFetch = installMockFetch(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve('{"errors":[{"code":"BAD_REQUEST"}]}'),
        }),
      );

      const client = await getSquareClient();
      let err: Error | undefined;
      try {
        await client!.orders.get({ orderId: "bad" });
      } catch (e) {
        err = e as Error;
      }
      // Assert outside the try so a missing rejection can't be swallowed.
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain("Status code: 400");
      expect(err!.message).toContain("BAD_REQUEST");
    });

    test("locations.list sends GET to /v2/locations", async () => {
      mockFetch = installMockFetch(() =>
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
      mockFetch = installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      await client!.orders.get({ orderId: "test" });

      expect(mockFetch.calls[0]!.args[0]).toContain("connect.squareup.com");
    });
  });
});
