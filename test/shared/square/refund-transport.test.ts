/* jscpd:ignore-start -- shared import block with rest-transport.test.ts */
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

/* jscpd:ignore-end */

describeSquare(() => {
  describe("Square refund REST transport", () => {
    let originalFetch: typeof globalThis.fetch;
    let mockFetch: { calls: FetchCall[] };

    beforeEach(async () => {
      originalFetch = globalThis.fetch;
      await settings.update.square.accessToken("EAAAl_refund_transport");
      await settings.update.square.sandbox(true);
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("sends correct snake_case body to /v2/refunds", async () => {
      mockFetch = installMockFetch(() =>
        Promise.resolve(
          jsonResponse({ refund: { id: "ref_1", status: "COMPLETED" } }),
        ),
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
      expect(opts.headers!.Authorization).toBe("Bearer EAAAl_refund_transport");
      const body = JSON.parse(opts.body!);
      expect(body.idempotency_key).toBe("idem-ref");
      expect(body.payment_id).toBe("pay_1");
      expect(body.amount_money.amount).toBe(3000);
      expect(body.amount_money.currency).toBe("GBP");
    });

    test("returns the raw refund response for the boundary validator", async () => {
      mockFetch = installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            refund: { id: "ref_done", status: "COMPLETED" },
          }),
        ),
      );

      const client = await getSquareClient();
      // The client returns raw JSON — squareApi.refundPayment validates it
      // with a Valibot schema at the boundary.
      const result = (await client!.refunds.refundPayment({
        amountMoney: { amount: BigInt(4250), currency: "USD" },
        idempotencyKey: "idem-status",
        paymentId: "pay_status",
      })) as { refund: { id: string; status: string } };

      expect(result.refund.id).toBe("ref_done");
      expect(result.refund.status).toBe("COMPLETED");
    });

    test("returns the raw response even when no refund is present", async () => {
      mockFetch = installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await getSquareClient();
      // The client returns the raw response — it does NOT normalize it.
      // The squareApi layer's Valibot parse would throw on this (refund is
      // required), but the transport client itself just passes it through.
      const result = (await client!.refunds.refundPayment({
        amountMoney: { amount: BigInt(1500), currency: "EUR" },
        idempotencyKey: "idem-empty",
        paymentId: "pay_empty",
      })) as Record<string, never>;

      expect(result.refund).toBeUndefined();
    });

    test("uses production URL when sandbox is disabled", async () => {
      resetSquareClient();
      await settings.update.square.sandbox(false);
      mockFetch = installMockFetch(() =>
        Promise.resolve(
          jsonResponse({ refund: { id: "ref_prod", status: "COMPLETED" } }),
        ),
      );

      const client = await getSquareClient();
      await client!.refunds.refundPayment({
        amountMoney: { amount: BigInt(500), currency: "USD" },
        idempotencyKey: "idem-prod",
        paymentId: "pay_prod",
      });

      expect(mockFetch.calls[0]!.args[0]).toContain("connect.squareup.com");
    });
  });
});
