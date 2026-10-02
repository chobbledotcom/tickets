/** The webhook and read surfaces this branch's expiry work leans on: what a
 * webhook books, what an unreadable order or payment answers, what one
 * payment read is worth, and how the manual webhook setup refuses. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { squareApi } from "#shared/square/api.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  foundPayment,
  withOrderAndPayment,
} from "#test/shared/square-provider/helpers.ts";
import { asSession } from "#test-utils/payment-session.ts";
import {
  SQUARE_ORDER_META,
  setupSquareProviderSuite,
  squareMoney,
} from "#test-utils/square/fixtures.ts";
import { squareOrderRead } from "#test-utils/square/outcomes.ts";

describe("square-provider webhook and reads", () => {
  const debug = setupSquareProviderSuite();

  describe("resolveWebhookSession", () => {
    test("skips a non-completed payment and says so in the log", async () => {
      const result = await squarePaymentProvider.resolveWebhookSession({
        data: { object: { id: "pay_1", status: "PENDING" } },
        id: "evt_1",
        type: "payment.updated",
      });
      expect(result).toBe("skip");
      expect(debug().calls.at(-1)?.args).toEqual([
        "[Square] Skipping webhook for non-completed payment (status=PENDING)",
      ]);
    });
  });

  describe("retrieveSession canceled order", () => {
    test("logs a foreign-metadata order and reads no session from it", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_foreign",
            metadata: {},
            state: "COMPLETED",
            tenders: [],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      expect(
        await squarePaymentProvider.retrieveSession("order_foreign"),
      ).toBeNull();
      expect(debug().calls.at(-1)?.args).toEqual([
        "[Square] Square order does not carry app metadata",
      ]);
    });

    test("skips a foreign-metadata webhook order instead of retrying it", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_foreign_hook",
            metadata: {},
            state: "COMPLETED",
            tenders: [{ id: "tender_1", paymentId: "pay_1" }],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      expect(
        await squarePaymentProvider.retrieveSession(
          "order_foreign_hook",
          "pay_1",
        ),
      ).toBeNull();
      expect(debug().calls.at(-1)?.args).toEqual([
        "[Square] Square order does not carry app metadata",
      ]);
    });

    test("raises a completed webhook order whose metadata is malformed", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_malformed",
            metadata: { _origin: "square" },
            state: "COMPLETED",
            tenders: [{ id: "tender_1", paymentId: "pay_1" }],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      await expect(
        squarePaymentProvider.retrieveSession("order_malformed", "pay_1"),
      ).rejects.toThrow("Completed Square order is missing required metadata");
    });

    test("logs a malformed-metadata order it cannot read", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_malformed_organic",
            metadata: { _origin: "square" },
            state: "COMPLETED",
            tenders: [],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      expect(
        await squarePaymentProvider.retrieveSession("order_malformed_organic"),
      ).toBeNull();
      expect(debug().calls.at(-1)?.args).toEqual([
        "[Square] Square order is missing required metadata fields",
      ]);
    });

    test("reads a canceled order as failed, not unpaid", async () => {
      await withOrderAndPayment(
        "order_canceled",
        "CANCELED",
        { id: "pay_1", status: "PENDING" },
        async () => {
          const session =
            await squarePaymentProvider.retrieveSession("order_canceled");
          expect(asSession(session).paymentStatus).toBe("failed");
        },
      );
    });

    test("refuses a payment that reports another order", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_mine",
            metadata: SQUARE_ORDER_META,
            state: "COMPLETED",
            tenders: [{ id: "tender_1", paymentId: "pay_1" }],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      using _payment = stub(squareApi, "readPayment", () =>
        Promise.resolve(
          foundPayment({
            amountMoney: squareMoney(1000),
            id: "pay_1",
            orderId: "order_other",
            status: "COMPLETED",
          }),
        ),
      );
      await expect(
        squarePaymentProvider.retrieveSession("order_mine"),
      ).rejects.toThrow("Square payment reports a different order");
    });

    test("raises a webhook whose completed payment names a missing order", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(squareOrderRead(null)),
      );
      await expect(
        squarePaymentProvider.retrieveSession("order_missing", "pay_gone"),
      ).rejects.toThrow(
        "Square order is not readable yet for a completed payment",
      );
    });

    test("raises a completed webhook payment that names no order", async () => {
      await expect(
        squarePaymentProvider.resolveWebhookSession({
          data: { object: { id: "pay_1", status: "COMPLETED" } },
          id: "evt_1",
          type: "payment.updated",
        }),
      ).rejects.toThrow("Completed Square payment is missing order id");
    });

    test("raises a webhook payment that names no status", async () => {
      await expect(
        squarePaymentProvider.resolveWebhookSession({
          data: { object: { id: "pay_1" } },
          id: "evt_1",
          type: "payment.updated",
        }),
      ).rejects.toThrow("Square payment webhook is missing status");
    });

    test("reads a webhook that is not a payment as nothing to do", async () => {
      expect(
        await squarePaymentProvider.resolveWebhookSession({
          data: { object: {} },
          id: "evt_1",
          type: "refund.updated",
        }),
      ).toBeNull();
    });

    test("skips a one-character payment id without reading Square", async () => {
      const result = await squarePaymentProvider.resolveWebhookSession({
        data: { object: { id: "p", status: "PENDING" } },
        id: "evt_1",
        type: "payment.updated",
      });
      expect(result).toBe("skip");
    });

    test("raises a webhook payment that names no payment id", async () => {
      await expect(
        squarePaymentProvider.resolveWebhookSession({
          data: { object: { order_id: "order_1", status: "COMPLETED" } },
          id: "evt_1",
          type: "payment.updated",
        }),
      ).rejects.toThrow("Square payment webhook is missing id");
    });

    test("says a webhook payment Square will not reread is unreadable", async () => {
      using _order = stub(squareApi, "readOrder", () =>
        Promise.resolve(
          squareOrderRead({
            id: "order_gone",
            metadata: SQUARE_ORDER_META,
            state: "COMPLETED",
            tenders: [],
            totalMoney: squareMoney(1000),
          }),
        ),
      );
      using _payment = stub(squareApi, "readPayment", () =>
        Promise.resolve(squareOrderRead(null) as never),
      );
      await expect(
        squarePaymentProvider.retrieveSession("order_gone", "pay_gone"),
      ).rejects.toThrow(
        "Square payment did not read back as completed (status=unreadable)",
      );
    });

    test("reports a blank status as blank, not unreadable", async () => {
      await withOrderAndPayment(
        "order_blank",
        "COMPLETED",
        { id: "pay_blank", status: "" },
        async () => {
          await expect(
            squarePaymentProvider.retrieveSession("order_blank", "pay_blank"),
          ).rejects.toThrow(
            "Square payment did not read back as completed (status=)",
          );
        },
      );
    });
  });

  describe("setupWebhookEndpoint", () => {
    test("refuses with the manual-setup instruction", async () => {
      const result = await squarePaymentProvider.setupWebhookEndpoint(
        "signing_secret",
        "https://example.com/hooks/square",
      );
      expect(result).toEqual({
        error:
          "Square webhooks must be configured manually in the Square Developer Dashboard",
        success: false,
      });
    });
  });

  describe("readCharge", () => {
    test("reads a completed payment's charge money", async () => {
      using _payment = stub(squareApi, "readPayment", () =>
        Promise.resolve(
          foundPayment({
            amountMoney: squareMoney(1000),
            id: "pay_1",
            refundedMoney: squareMoney(200),
            status: "COMPLETED",
          }),
        ),
      );
      expect(await squarePaymentProvider.readCharge("pay_1")).toEqual({
        resource: {
          captured: { amount: 1000, currency: "GBP" },
          confirmedRefunded: { amount: 200, currency: "GBP" },
          refunds: [],
        },
        status: "found",
      });
    });

    test("refuses a payment Square has not completed", async () => {
      using _payment = stub(squareApi, "readPayment", () =>
        Promise.resolve(
          foundPayment({
            amountMoney: squareMoney(1000),
            id: "pay_2",
            status: "PENDING",
          }),
        ),
      );
      expect(await squarePaymentProvider.readCharge("pay_2")).toEqual({
        reason: "unsupported_status",
        status: "invalid",
      });
    });
  });
});
