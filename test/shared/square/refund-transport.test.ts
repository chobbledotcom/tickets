/* jscpd:ignore-start -- shared import block with rest-transport.test.ts */
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { squareApi } from "#shared/square.ts";
import {
  type FetchCall,
  installMockFetch,
  jsonResponse,
} from "#test/shared/square/mock-fetch.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";

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
          jsonResponse({
            refund: {
              amount_money: { amount: 3000, currency: "GBP" },
              id: "ref_1",
              payment_id: "pay_1",
              status: "COMPLETED",
            },
          }),
        ),
      );

      const client = await squareApi.getSquareClient();
      await client!.refunds.requestRefund({
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

    test("returns a validated refund response", async () => {
      mockFetch = installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            refund: {
              amount_money: { amount: 4250, currency: "USD" },
              id: "ref_done",
              payment_id: "pay_status",
              status: "COMPLETED",
            },
          }),
        ),
      );

      const client = await squareApi.getSquareClient();
      const result = await client!.refunds.requestRefund({
        amountMoney: { amount: BigInt(4250), currency: "USD" },
        idempotencyKey: "idem-status",
        paymentId: "pay_status",
      });

      expect(result.id).toBe("ref_done");
      expect(result.status).toBe("COMPLETED");
    });

    test("retrieves one exact refund by id", async () => {
      mockFetch = installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            refund: {
              amount_money: { amount: 600, currency: "GBP" },
              id: "ref_exact",
              payment_id: "pay_exact",
              status: "PENDING",
            },
          }),
        ),
      );
      const client = await squareApi.getSquareClient();
      expect(await client!.refunds.get({ refundId: "ref_exact" })).toEqual({
        amount: { amount: 600, currency: "GBP" },
        id: "ref_exact",
        paymentId: "pay_exact",
        status: "PENDING",
      });
      expect(mockFetch.calls[0]?.args[0]).toBe(
        "https://connect.squareupsandbox.com/v2/refunds/ref_exact",
      );
    });

    test("rejects a successful response with no refund", async () => {
      mockFetch = installMockFetch(() => Promise.resolve(jsonResponse({})));

      const client = await squareApi.getSquareClient();
      await expect(
        client!.refunds.requestRefund({
          amountMoney: { amount: BigInt(1500), currency: "EUR" },
          idempotencyKey: "idem-empty",
          paymentId: "pay_empty",
        }),
      ).rejects.toThrow();
    });

    for (const [name, change] of [
      ["resource id", { id: undefined }],
      ["documented status", { status: "APPROVED" }],
    ] as const) {
      test(`rejects a refund without a valid ${name}`, async () => {
        mockFetch = installMockFetch(() =>
          Promise.resolve(
            jsonResponse({
              refund: Object.assign(
                {
                  amount_money: { amount: 1500, currency: "EUR" },
                  id: "ref_boundary" as string | undefined,
                  payment_id: "pay_boundary",
                  status: "PENDING",
                },
                change,
              ),
            }),
          ),
        );
        const client = await squareApi.getSquareClient();
        await expect(
          client!.refunds.requestRefund({
            amountMoney: { amount: 1500n, currency: "EUR" },
            idempotencyKey: "idem-boundary",
            paymentId: "pay_boundary",
          }),
        ).rejects.toThrow();
      });
    }

    test("uses production URL when sandbox is disabled", async () => {
      squareApi.resetSquareClient();
      await settings.update.square.sandbox(false);
      mockFetch = installMockFetch(() =>
        Promise.resolve(
          jsonResponse({
            refund: {
              amount_money: { amount: 500, currency: "USD" },
              id: "ref_prod",
              payment_id: "pay_prod",
              status: "COMPLETED",
            },
          }),
        ),
      );

      const client = await squareApi.getSquareClient();
      await client!.refunds.requestRefund({
        amountMoney: { amount: BigInt(500), currency: "USD" },
        idempotencyKey: "idem-prod",
        paymentId: "pay_prod",
      });

      expect(mockFetch.calls[0]!.args[0]).toContain("connect.squareup.com");
    });
  });
});
