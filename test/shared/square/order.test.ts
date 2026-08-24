import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import { squareApi } from "#shared/square/api.ts";
import {
  withSquareAnswer,
  withSquareClient,
} from "#test-utils/square/fixtures.ts";
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
          expect(ordersGet.calls).toHaveLength(1);
          expect(ordersGet.calls[0]?.args[0]).toEqual({
            orderId: "order_missing",
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

    // The answer is read where it arrives, so an order Square states in a way
    // we cannot read reaches the caller as a refusal, not as a crash.
    test("reads an unreadable answer as a malformed response", async () => {
      const read = await withSquareAnswer(
        { order: { id: "ord_1", metadata: { a: 1 } } },
        () => squareApi.readOrder("ord_1"),
      );
      expect(read).toEqual({
        reason: "malformed_response",
        status: "invalid",
      });
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
      [
        "404",
        transportError.answered(providerDetail.square(), 404),
        { status: "missing" },
      ],
      [
        "503",
        transportError.answered(providerDetail.square(), 503),
        { reason: "provider_error", status: "unavailable" },
      ],
      [
        "network failure",
        transportError.unreachable(providerDetail.square(), "network_error"),
        { reason: "network_error", status: "unavailable" },
      ],
      [
        "malformed response",
        transportError.unusable(providerDetail.square()),
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
  });
});
