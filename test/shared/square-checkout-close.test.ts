import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { checkoutIntent } from "#test-utils/checkout.ts";
import { withMocks } from "#test-utils/mocks.ts";

describe("Square hosted checkout closing", () => {
  const withSquareOrderStates = (
    states: string[],
    deleteLink: () => Promise<unknown>,
    body: (calls: {
      deleteLink: () => number;
      order: () => number;
    }) => void | Promise<void>,
  ) => {
    const get = spy((input: { orderId: string }) =>
      Promise.resolve({
        order: {
          id: input.orderId,
          state: states.shift() ?? "OPEN",
          tenders: [],
          totalMoney: { amount: BigInt(1000), currency: "GBP" },
        },
      }),
    );
    const remove = spy(deleteLink);
    const client = {
      checkout: { paymentLinks: { delete: remove } },
      orders: { get },
    };
    return withMocks(
      () =>
        stub(squareApi, "getSquareClient", () =>
          Promise.resolve(client as never),
        ),
      () =>
        body({
          deleteLink: () => remove.calls.length,
          order: () => get.calls.length,
        }),
    );
  };

  const expectWrongDeletedResource = (deleted: {
    cancelledOrderId: string;
    id: string;
  }) =>
    withSquareOrderStates(
      ["OPEN"],
      () => Promise.resolve(deleted),
      async (calls) => {
        await expect(
          squareApi.closePaymentLink("link", "order"),
        ).rejects.toThrow("Square closed the wrong payment link or order");
        expect(calls.order()).toBe(1);
      },
    );

  test("keeps the payment-link id while the session id remains the order id", () =>
    withMocks(
      () =>
        stub(squareApi, "createPaymentLink", () =>
          Promise.resolve({
            id: "link_123",
            orderId: "order_123",
            url: "https://square.link/u/123",
          }),
        ),
      async () => {
        expect(
          await squarePaymentProvider.createCheckoutSession(
            checkoutIntent(),
            "https://example.com",
          ),
        ).toEqual({
          checkoutUrl: "https://square.link/u/123",
          providerCheckoutId: "link_123",
          sessionId: "order_123",
        });
      },
    ));

  test("closes the payment link using both provider identifiers", () =>
    withMocks(
      () =>
        stub(squareApi, "closePaymentLink", () => Promise.resolve("closed")),
      async (close) => {
        expect(
          await squarePaymentProvider.closeCheckout({
            providerCheckoutId: "link_open",
            sessionId: "order_open",
          }),
        ).toBe("closed");
        expect(close.calls[0]!.args).toEqual(["link_open", "order_open"]);
      },
    ));

  test("reports an order won by payment as paid", () =>
    withMocks(
      () => stub(squareApi, "closePaymentLink", () => Promise.resolve("paid")),
      async () => {
        expect(
          await squarePaymentProvider.closeCheckout({
            providerCheckoutId: "link_paid",
            sessionId: "order_paid",
          }),
        ).toBe("paid");
      },
    ));

  test("propagates deletion failure instead of claiming the link is closed", () =>
    withMocks(
      () =>
        stub(squareApi, "closePaymentLink", () =>
          Promise.reject(new Error("Square unavailable")),
        ),
      async () => {
        await expect(
          squarePaymentProvider.closeCheckout({
            providerCheckoutId: "link_unknown",
            sessionId: "order_unknown",
          }),
        ).rejects.toThrow("Square unavailable");
      },
    ));

  test("propagates a delete failure when the rechecked order remains open", () =>
    withSquareOrderStates(
      ["OPEN", "OPEN"],
      () => Promise.reject(new Error("Square unavailable")),
      async (calls) => {
        await expect(
          squareApi.closePaymentLink("link", "order"),
        ).rejects.toThrow("Square unavailable");
        expect(calls.order()).toBe(2);
      },
    ));

  test("deletes an unpaid payment link and verifies the cancelled order", () =>
    withSquareOrderStates(
      ["OPEN"],
      () =>
        Promise.resolve({
          cancelledOrderId: "order_open",
          id: "link_open",
        }),
      async (calls) => {
        expect(
          await squareApi.closePaymentLink("link_open", "order_open"),
        ).toBe("closed");
        expect(calls.order()).toBe(1);
        expect(calls.deleteLink()).toBe(1);
      },
    ));

  test("does not delete an open order whose tender payment completed", () => {
    const remove = spy(() => Promise.resolve({}));
    const client = {
      checkout: { paymentLinks: { delete: remove } },
      orders: {
        get: () =>
          Promise.resolve({
            order: {
              id: "order_paid",
              state: "OPEN",
              tenders: [{ paymentId: "payment_paid" }],
              totalMoney: { amount: BigInt(1000), currency: "GBP" },
            },
          }),
      },
    };
    return withMocks(
      () => ({
        client: stub(squareApi, "getSquareClient", () =>
          Promise.resolve(client as never),
        ),
        payment: stub(squareApi, "retrievePayment", () =>
          Promise.resolve({
            amountMoney: { amount: BigInt(1000), currency: "GBP" },
            id: "payment_paid",
            orderId: "order_paid",
            status: "COMPLETED",
          }),
        ),
      }),
      async () => {
        expect(
          await squareApi.closePaymentLink("link_paid", "order_paid"),
        ).toBe("paid");
        expect(remove.calls.length).toBe(0);
      },
    );
  });

  for (const [state, result] of [
    ["COMPLETED", "paid"],
    ["CANCELED", "closed"],
  ] as const) {
    test(`returns ${result} without deleting a ${state} Square order`, () =>
      withSquareOrderStates(
        [state],
        () => Promise.resolve({}),
        async (calls) => {
          expect(await squareApi.closePaymentLink("link", "order")).toBe(
            result,
          );
          expect(calls.deleteLink()).toBe(0);
        },
      ));
  }

  for (const [afterRace, result] of [
    ["COMPLETED", "paid"],
    ["CANCELED", "closed"],
  ] as const) {
    test(`returns ${result} when the order becomes ${afterRace} during deletion`, () =>
      withSquareOrderStates(
        ["OPEN", afterRace],
        () => Promise.reject(new Error("state changed")),
        async () => {
          expect(await squareApi.closePaymentLink("link", "order")).toBe(
            result,
          );
        },
      ));
  }

  test("throws when the payment-link deletion response names another order", () =>
    expectWrongDeletedResource({ cancelledOrderId: "other", id: "link" }));

  test("throws when the payment-link deletion response names another link", () =>
    expectWrongDeletedResource({ cancelledOrderId: "order", id: "other" }));

  test("throws when the Square order does not exist", () => {
    const client = {
      checkout: { paymentLinks: { delete: spy() } },
      orders: { get: () => Promise.resolve({ order: null }) },
    };
    return withMocks(
      () =>
        stub(squareApi, "getSquareClient", () =>
          Promise.resolve(client as never),
        ),
      async () => {
        await expect(
          squareApi.closePaymentLink("link", "missing"),
        ).rejects.toThrow("Square order missing not found");
      },
    );
  });

  test("throws when the Square order has no total", () => {
    const client = {
      checkout: { paymentLinks: { delete: spy() } },
      orders: {
        get: () => Promise.resolve({ order: { id: "order", state: "OPEN" } }),
      },
    };
    return withMocks(
      () =>
        stub(squareApi, "getSquareClient", () =>
          Promise.resolve(client as never),
        ),
      async () => {
        await expect(
          squareApi.closePaymentLink("link", "order"),
        ).rejects.toThrow("Square order order has no total");
      },
    );
  });

  test("throws when Square is not configured", () =>
    withMocks(
      () => stub(squareApi, "getSquareClient", () => Promise.resolve(null)),
      async () => {
        await expect(
          squareApi.closePaymentLink("link", "order"),
        ).rejects.toThrow("No Square client configured");
      },
    ));
});
