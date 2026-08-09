import { afterAll, afterEach, beforeEach, describe } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { type SquareClient, squareApi } from "#shared/square.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { reclaimLeakedFdsNow } from "#test-utils/reclaim-fds.ts";

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
  // Spy a provided implementation, or a bare no-op spy that returns undefined.
  const asSpy = (impl?: MockFn) => (impl ? spy(impl) : spy());
  const checkoutCreate = asSpy(impls.checkoutCreate);
  const ordersGet = asSpy(impls.ordersGet);
  const paymentsGet = asSpy(impls.paymentsGet);
  const refundsRefundPayment = asSpy(impls.refundsRefundPayment);
  const locationsList = asSpy(impls.locationsList);

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
      squareApi.resetSquareClient();
      await createTestDb();
    });

    afterEach(() => {
      squareApi.resetSquareClient();
      resetDb();
    });

    // These small split files each run fewer than RECLAIM_FDS_EVERY DB setups,
    // so createTestDb's amortised GC never fires — hand back libsql's leaked
    // descriptors at suite teardown, exactly as describeWithEnv does.
    afterAll(() => reclaimLeakedFdsNow());

    body();
  });
};
