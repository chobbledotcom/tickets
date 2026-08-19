import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { squareApi } from "#shared/square/api.ts";
import {
  SquareApiError,
  SquareConnectionError,
  SquareProtocolError,
} from "#shared/square/transport.ts";
import { withSquareClient } from "#test-utils/square/fixtures.ts";
import { describeSquare } from "#test-utils/square/harness.ts";

describeSquare(() => {
  describe("readOrder", () => {
    test("returns unavailable when access token not set", async () => {
      const result = await squareApi.readOrder("order_123");
      expect(result).toEqual({
        reason: "not_configured",
        status: "unavailable",
      });
    });

    test("refuses a successful response with no order", async () => {
      await withSquareClient(
        { ordersGet: () => Promise.resolve({ order: null }) },
        async ({ ordersGet }) => {
          const result = await squareApi.readOrder("order_missing");
          expect(result).toEqual({
            reason: "missing_documented_resource",
            status: "invalid",
          });
          expect(ordersGet.calls[0]!.args[0]).toEqual({
            orderId: "order_missing",
          });
        },
      );
    });

    test("refuses malformed order fields", async () => {
      await withSquareClient(
        { ordersGet: () => Promise.resolve({ order: { id: "" } }) },
        async () => {
          expect(await squareApi.readOrder("order_malformed")).toEqual({
            reason: "malformed_response",
            status: "invalid",
          });
        },
      );
    });

    test("refuses an order with a different id", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({ order: { id: "order_someone_else" } }),
        },
        async () => {
          expect(await squareApi.readOrder("order_expected")).toEqual({
            reason: "mismatched_id",
            status: "invalid",
          });
        },
      );
    });

    test("does not relabel an internal failure as a provider outcome", async () => {
      await withSquareClient(
        { ordersGet: () => Promise.reject(new Error("order mapper bug")) },
        async () => {
          await expect(squareApi.readOrder("order_bug")).rejects.toThrow(
            "order mapper bug",
          );
        },
      );
    });

    for (const [name, error, expected] of [
      ["404", new SquareApiError(404), { status: "missing" }],
      [
        "503",
        new SquareApiError(503),
        { reason: "provider_error", status: "unavailable" },
      ],
      [
        "network failure",
        new SquareConnectionError("network_error"),
        { reason: "network_error", status: "unavailable" },
      ],
      [
        "malformed response",
        new SquareProtocolError(),
        { reason: "malformed_response", status: "invalid" },
      ],
    ] as const) {
      test(`keeps a ${name} order outcome distinct`, async () => {
        await withSquareClient(
          { ordersGet: () => Promise.reject(error) },
          async () => {
            expect(await squareApi.readOrder("order_failure")).toEqual(
              expected,
            );
          },
        );
      });
    }

    test("maps tender paymentId correctly", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_tenders",
                metadata: {
                  email: "john@example.com",
                  items: '[{"e":1,"q":1,"p":0}]',
                  name: "John",
                },
                state: "COMPLETED",
                tenders: [
                  { id: "tender_1", paymentId: "pay_abc" },
                  { id: "tender_2", paymentId: null },
                ],
                totalMoney: { amount: BigInt(2000), currency: "GBP" },
              },
            }),
        },
        async () => {
          const result = await squareApi.readOrder("order_tenders");
          expect(result.status).toBe("found");
          if (result.status !== "found") return;
          expect(result.resource.tenders).toHaveLength(2);
          expect(result.resource.tenders?.[0]?.paymentId).toBe("pay_abc");
          expect(result.resource.tenders?.[1]?.paymentId).toBeUndefined();
        },
      );
    });

    test("returns correct shape with state and id", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_shape",
                metadata: undefined,
                state: "OPEN",
                tenders: undefined,
                totalMoney: { amount: BigInt(0), currency: "GBP" },
              },
            }),
        },
        async () => {
          const result = await squareApi.readOrder("order_shape");
          expect(result.status).toBe("found");
          if (result.status !== "found") return;
          expect(result.resource.id).toBe("order_shape");
          expect(result.resource.state).toBe("OPEN");
          expect(result.resource.metadata).toBeUndefined();
          expect(result.resource.tenders).toBeUndefined();
        },
      );
    });

    test("refuses a non-text order metadata value", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_metadata",
                metadata: {
                  removed_null: null,
                  stored_key: "stored value",
                },
                totalMoney: { amount: BigInt(0), currency: "GBP" },
              },
            }),
        },
        async () => {
          expect(await squareApi.readOrder("order_metadata")).toEqual({
            reason: "malformed_response",
            status: "invalid",
          });
        },
      );
    });

    test("maps totalMoney from order response", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_with_total",
                metadata: {
                  email: "john@example.com",
                  items: '[{"e":1,"q":1,"p":0}]',
                  name: "John",
                },
                state: "COMPLETED",
                tenders: [{ id: "tender_1", paymentId: "pay_total" }],
                totalMoney: { amount: BigInt(7500), currency: "GBP" },
              },
            }),
        },
        async () => {
          const result = await squareApi.readOrder("order_with_total");
          expect(result.status).toBe("found");
          if (result.status !== "found") return;
          expect(result.resource.totalMoney.amount).toBe(BigInt(7500));
          expect(result.resource.totalMoney.currency).toBe("GBP");
        },
      );
    });

    // Square's own values are carried through untouched, however empty they
    // look: a zero total is a real free order, and a blank currency is
    // something the payment boundary must see to refuse. Only a wholly absent
    // money object becomes null.
    for (const [name, given, expected] of [
      [
        "a zero amount",
        { amount: BigInt(0), currency: "GBP" },
        {
          amount: BigInt(0),
          currency: "GBP",
        },
      ],
      [
        "a blank currency",
        { amount: BigInt(500), currency: "" },
        {
          amount: BigInt(500),
          currency: "",
        },
      ],
    ] as const) {
      test(`keeps ${name} on the order total`, async () => {
        await withSquareClient(
          {
            ordersGet: () =>
              Promise.resolve({
                order: {
                  id: "order_edge_total",
                  metadata: { name: "John" },
                  state: "COMPLETED",
                  totalMoney: given,
                },
              }),
          },
          async () => {
            const result = await squareApi.readOrder("order_edge_total");
            expect(result.status).toBe("found");
            if (result.status !== "found") return;
            expect(result.resource.totalMoney).toEqual(expected);
          },
        );
      });
    }

    test("carries a missing order total through as null", async () => {
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: {
                id: "order_no_total",
                metadata: {
                  email: "john@example.com",
                  items: '[{"e":1,"q":1,"p":0}]',
                  name: "John",
                },
                state: "COMPLETED",
                tenders: [{ id: "tender_1", paymentId: "pay_no_total" }],
              },
            }),
        },
        async () => {
          // A missing money object remains explicitly unreadable, so the
          // payment boundary refuses the charge instead of treating it as £0.
          const result = await squareApi.readOrder("order_no_total");
          expect(result.status).toBe("found");
          if (result.status !== "found") return;
          expect(result.resource.totalMoney).toEqual({
            amount: null,
            currency: null,
          });
        },
      );
    });
  });
});
