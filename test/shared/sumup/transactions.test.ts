/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { APIError } from "@sumup/sdk";
import { settings } from "#shared/db/settings.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  makeSumupClient,
  setupSumupSuite,
  withSumupClient,
} from "#test-utils/sumup.ts";

/* jscpd:ignore-end */

describe("sumup transactions", () => {
  const { errorSpy } = setupSumupSuite();

  const transactionWire = (over: Record<string, unknown> = {}) => ({
    amount: 10,
    currency: "GBP",
    id: "txn",
    merchant_code: "MC123",
    status: "SUCCESSFUL",
    ...over,
  });

  const expectTransactionBody = (
    body: unknown,
    expected: Awaited<ReturnType<typeof sumupApi.readTransactionMoney>>,
  ): Promise<void> =>
    withSumupClient(
      makeSumupClient({ txnGet: () => Promise.resolve(body) }),
      async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual(expected);
      },
    );

  describe("readTransactionMoney", () => {
    test("reports missing configuration without calling SumUp", async () => {
      settings.setForTest({ sumup_merchant_code: "" });
      await withSumupClient(makeSumupClient({}), async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          reason: "not_configured",
          status: "unavailable",
        });
      });
    });

    test("reports an absent client as missing configuration", async () => {
      await withSumupClient(null, async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          reason: "not_configured",
          status: "unavailable",
        });
      });
    });

    test("reports the money taken and keeps only the refund events", async () => {
      const client = makeSumupClient({
        txnGet: () =>
          Promise.resolve(
            transactionWire({
              transaction_events: [
                { amount: 10, event_type: "PAYOUT", status: "PAID_OUT" },
                { amount: 4, event_type: "REFUND", status: "REFUNDED" },
              ],
            }),
          ),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          resource: {
            amount: 10,
            currency: "GBP",
            refundEvents: [{ amount: 4, status: "REFUNDED" }],
          },
          status: "found",
        });
      });
    });

    test("reports no refund events when the transaction lists none", async () => {
      const client = makeSumupClient({
        txnGet: () => Promise.resolve(transactionWire()),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          resource: { amount: 10, currency: "GBP", refundEvents: [] },
          status: "found",
        });
      });
    });

    // Missing money stays missing for the money adapter to name precisely.
    test("passes a missing amount and currency through untouched", async () => {
      const client = makeSumupClient({
        txnGet: () =>
          Promise.resolve(
            transactionWire({
              amount: undefined,
              currency: undefined,
            }),
          ),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          resource: {
            amount: undefined,
            currency: undefined,
            refundEvents: [],
          },
          status: "found",
        });
      });
    });

    test("refuses a malformed transaction container", async () => {
      await expectTransactionBody(
        transactionWire({ transaction_events: "not a list" }),
        {
          reason: "malformed_response",
          status: "invalid",
        },
      );
    });

    for (const [name, fields, reason] of [
      ["another transaction", { id: "txn_other" }, "mismatched_id"],
      ["another account", { merchant_code: "OTHER" }, "mismatched_account"],
      ["a pending transaction", { status: "PENDING" }, "unsupported_status"],
      ["a failed transaction", { status: "FAILED" }, "unsupported_status"],
    ] as const) {
      test(`refuses ${name}`, async () => {
        const client = makeSumupClient({
          txnGet: () => Promise.resolve(transactionWire(fields)),
        });
        await withSumupClient(client, async () => {
          expect(await sumupApi.readTransactionMoney("txn")).toEqual({
            reason,
            status: "invalid",
          });
        });
      });
    }

    for (const field of ["id", "merchant_code", "status"] as const) {
      test(`refuses a transaction missing ${field}`, async () => {
        await expectTransactionBody(transactionWire({ [field]: undefined }), {
          reason: "missing_documented_resource",
          status: "invalid",
        });
      });
    }

    test("refuses an event with no type instead of dropping it", async () => {
      await expectTransactionBody(
        transactionWire({
          transaction_events: [{ amount: 10, status: "REFUNDED" }],
        }),
        {
          reason: "missing_documented_resource",
          status: "invalid",
        },
      );
    });

    test("refuses an event type SumUp does not document", async () => {
      await expectTransactionBody(
        transactionWire({
          transaction_events: [
            { amount: 10, event_type: "UNKNOWN", status: "SUCCESSFUL" },
          ],
        }),
        {
          reason: "malformed_response",
          status: "invalid",
        },
      );
    });

    test("refuses a chargeback event instead of treating it as refundable", async () => {
      const client = makeSumupClient({
        txnGet: () =>
          Promise.resolve(
            transactionWire({
              transaction_events: [
                { amount: 10, event_type: "CHARGE_BACK", status: "SUCCESSFUL" },
              ],
            }),
          ),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          reason: "unsupported_status",
          status: "invalid",
        });
      });
    });

    for (const [statusCode, expected] of [
      [404, { status: "missing" }],
      [429, { reason: "rate_limited", status: "unavailable" }],
      [500, { reason: "provider_error", status: "unavailable" }],
    ] as const) {
      test(`keeps an HTTP ${statusCode} transaction answer distinct`, async () => {
        const client = makeSumupClient({
          txnGet: () =>
            Promise.reject(
              new APIError(statusCode, "provider answer", new Response()),
            ),
        });
        await withSumupClient(client, async () => {
          expect(await sumupApi.readTransactionMoney("txn")).toEqual(expected);
        });
      });
    }

    test("reports a connection failure as unavailable", async () => {
      const client = makeSumupClient({
        txnGet: () => Promise.reject(new TypeError("connection reset")),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          reason: "network_error",
          status: "unavailable",
        });
      });
    });

    test("reports a timeout separately", async () => {
      const client = makeSumupClient({
        txnGet: () => Promise.reject(new DOMException("late", "TimeoutError")),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.readTransactionMoney("txn")).toEqual({
          reason: "timeout",
          status: "unavailable",
        });
      });
    });

    test("does not disguise an internal read error as a network failure", async () => {
      const failure = new Error("broken adapter");
      const client = makeSumupClient({
        txnGet: () => Promise.reject(failure),
      });
      await withSumupClient(client, async () => {
        await expect(sumupApi.readTransactionMoney("txn")).rejects.toBe(
          failure,
        );
      });
    });
  });

  describe("refundTransaction", () => {
    test("does not send without a merchant code", async () => {
      settings.setForTest({ sumup_merchant_code: "" });
      await withSumupClient(makeSumupClient({}), async () => {
        expect(await sumupApi.refundTransaction("txn")).toEqual({
          kind: "not_sent",
          reason: "not_configured",
        });
      });
      expect(errorSpy.contains("SumUp merchant code")).toBe(true);
    });

    test("reports a submitted refund without calling it completed", async () => {
      const calls: [string, string][] = [];
      const client = makeSumupClient({
        refund: (mc, id) => {
          calls.push([mc, id]);
          return Promise.resolve();
        },
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.refundTransaction("txn_r")).toEqual({
          kind: "sent",
        });
        expect(calls[0]).toEqual(["MC123", "txn_r"]);
      });
    });

    test("does not send when the client is unavailable", async () => {
      await withSumupClient(null, async () => {
        expect(await sumupApi.refundTransaction("txn")).toEqual({
          kind: "not_sent",
          reason: "not_configured",
        });
      });
    });

    test("reports an authoritative refusal", async () => {
      const client = makeSumupClient({
        refund: () =>
          Promise.reject(new APIError(422, "refused", new Response())),
      });
      await withSumupClient(client, async () => {
        expect(await sumupApi.refundTransaction("txn")).toEqual({
          kind: "rejected",
          reason: "rejected",
        });
      });
    });

    for (const [name, error, reason] of [
      [
        "provider failure",
        new APIError(500, "unknown", new Response()),
        "provider_error",
      ],
      ["lost connection", new TypeError("connection reset"), "network_error"],
      ["timeout", new DOMException("late", "TimeoutError"), "timeout"],
      ["HTTP timeout", new APIError(408, "late", new Response()), "timeout"],
      [
        "rate limit",
        new APIError(429, "slow down", new Response()),
        "rate_limited",
      ],
    ] as const) {
      test(`reports a ${name} as uncertain`, async () => {
        const client = makeSumupClient({
          refund: () => Promise.reject(error),
        });
        await withSumupClient(client, async () => {
          expect(await sumupApi.refundTransaction("txn")).toEqual({
            kind: "uncertain",
            reason,
          });
        });
      });
    }

    for (const [name, makeFailure] of [
      ["an internal refund error", () => new Error("broken adapter")],
      [
        "an API error missing its status",
        () => {
          const failure = new APIError(500, "missing status", new Response());
          Object.defineProperty(failure, "status", { value: undefined });
          return failure;
        },
      ],
    ] as const) {
      test(`does not disguise ${name}`, async () => {
        const failure = makeFailure();
        const client = makeSumupClient({
          refund: () => Promise.reject(failure),
        });
        await withSumupClient(client, async () => {
          await expect(sumupApi.refundTransaction("txn")).rejects.toBe(failure);
        });
      });
    }
  });
});
