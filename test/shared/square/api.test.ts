/** The Square client seam: every wrapper hands its call the same client
 * getter, so a stub on the getter reaches every call. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { squareApi } from "#shared/square/api.ts";

describe("square api seam", () => {
  test("endLink asks the client's payment-links cancel for the link id", async () => {
    const cancelled: string[] = [];
    using _client = stub(squareApi, "getSquareClient", () =>
      Promise.resolve({
        checkout: {
          paymentLinks: {
            cancel: async ({ linkId }: { linkId: string }) => {
              cancelled.push(linkId);
              return { cancelled_order_id: "order_1" };
            },
          },
        },
      } as never),
    );
    const answer = await squareApi.endLink("link_7");
    expect(cancelled).toEqual(["link_7"]);
    expect(answer).toEqual({ cancelled_order_id: "order_1" });
  });

  test("readOrder asks the client's orders get for the order id", async () => {
    const asked: string[] = [];
    using _client = stub(squareApi, "getSquareClient", () =>
      Promise.resolve({
        orders: {
          get: async ({ orderId }: { orderId: string }) => {
            asked.push(orderId);
            return { order: { id: orderId } };
          },
        },
      } as never),
    );
    const read = await squareApi.readOrder("order_9");
    expect(asked).toEqual(["order_9"]);
    expect(read.status).toBe("found");
  });

  test("readPayment asks the client's payments get for the payment id", async () => {
    const asked: string[] = [];
    using _client = stub(squareApi, "getSquareClient", () =>
      Promise.resolve({
        payments: {
          get: async ({ paymentId }: { paymentId: string }) => {
            asked.push(paymentId);
            return { payment: { id: paymentId, status: "COMPLETED" } };
          },
        },
      } as never),
    );
    const read = await squareApi.readPayment("payment_3");
    expect(asked).toEqual(["payment_3"]);
    expect(read.status).toBe("found");
  });

  test("a null client reads as an unavailable provider", async () => {
    using _client = stub(squareApi, "getSquareClient", () =>
      Promise.resolve(null),
    );
    const read = await squareApi.readOrder("order_1");
    expect(read.status).toBe("unavailable");
  });
});
