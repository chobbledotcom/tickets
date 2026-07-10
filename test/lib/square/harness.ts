import { afterEach, beforeEach, describe } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { resetSquareClient, type SquareClient } from "#shared/square.ts";
import { createTestDb, resetDb } from "#test-utils";

/** Mock implementation function type (accepts unknown args, returns unknown) */
type MockFn = (...args: unknown[]) => unknown;

/** Create a mock Square SDK client with spyable methods */
export const createMockClient = (
  impls: {
    checkoutCreate?: MockFn;
    ordersGet?: MockFn;
    paymentsGet?: MockFn;
    refundsRefundPayment?: MockFn;
    locationsList?: MockFn;
  } = {},
) => {
  const noop: MockFn = () => undefined;
  const checkoutCreate = spy(impls.checkoutCreate ?? noop);
  const ordersGet = spy(impls.ordersGet ?? noop);
  const paymentsGet = spy(impls.paymentsGet ?? noop);
  const refundsRefundPayment = spy(impls.refundsRefundPayment ?? noop);
  const locationsList = spy(impls.locationsList ?? noop);

  return {
    checkoutCreate,
    client: {
      checkout: { paymentLinks: { create: checkoutCreate } },
      locations: { list: locationsList },
      orders: { get: ordersGet },
      payments: { get: paymentsGet },
      refunds: { refundPayment: refundsRefundPayment },
    } as unknown as SquareClient,
    locationsList,
    ordersGet,
    paymentsGet,
    refundsRefundPayment,
  };
};

/**
 * Wraps a group of Square tests with the shared database setup every Square
 * suite needs: a fresh client before each test and a clean database around it.
 */
export const describeSquare = (body: () => void): void => {
  describe("square", () => {
    beforeEach(async () => {
      resetSquareClient();
      await createTestDb();
    });

    afterEach(() => {
      resetSquareClient();
      resetDb();
    });

    body();
  });
};
