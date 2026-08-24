/* jscpd:ignore-start -- shared import block with rest.test.ts */
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { ProviderTransportError } from "#payment/transport-error.ts";
import { squareApi } from "#shared/square/api.ts";
import {
  type FetchCall,
  installMockFetch,
  jsonResponse,
} from "#test/shared/square/mock-fetch.ts";
import { describeSquare } from "#test-utils/square/harness.ts";

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

    /** One complete refund answer, as Square sends it. */
    const refundBody = (id: string, amount: number) => ({
      refund: {
        amount_money: { amount, currency: "GBP" },
        id,
        payment_id: "pay_1",
        status: "COMPLETED",
      },
    });

    test("sends correct snake_case body to /v2/refunds", async () => {
      mockFetch = installMockFetch(() =>
        Promise.resolve(jsonResponse(refundBody("ref_1", 3000))),
      );

      const client = await squareApi.getSquareClient();
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

    test("reads Square's refund into the shape the engine judges", async () => {
      mockFetch = installMockFetch(() =>
        Promise.resolve(jsonResponse(refundBody("ref_done", 4250))),
      );

      const client = await squareApi.getSquareClient();
      const result = await client!.refunds.refundPayment({
        amountMoney: { amount: BigInt(4250), currency: "GBP" },
        idempotencyKey: "idem-status",
        paymentId: "pay_status",
      });

      expect(result.refund).toEqual({
        amountMoney: { amount: BigInt(4250), currency: "GBP" },
        id: "ref_done",
        paymentId: "pay_1",
        status: "COMPLETED",
      });
    });

    test("refuses an answer that names no refund", async () => {
      mockFetch = installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await squareApi.getSquareClient();
      await expect(
        client!.refunds.refundPayment({
          amountMoney: { amount: BigInt(1500), currency: "GBP" },
          idempotencyKey: "idem-empty",
          paymentId: "pay_empty",
        }),
      ).rejects.toBeInstanceOf(ProviderTransportError);
    });

    test("uses production URL when sandbox is disabled", async () => {
      squareApi.resetSquareClient();
      await settings.update.square.sandbox(false);
      mockFetch = installMockFetch(() =>
        Promise.resolve(jsonResponse(refundBody("ref_prod", 500))),
      );

      const client = await squareApi.getSquareClient();
      await client!.refunds.refundPayment({
        amountMoney: { amount: BigInt(500), currency: "GBP" },
        idempotencyKey: "idem-prod",
        paymentId: "pay_prod",
      });

      expect(mockFetch.calls[0]!.args[0]).toContain("connect.squareup.com");
    });
  });
});
