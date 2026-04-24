import { spy } from "@std/testing/mock";
import type { SquareClient } from "#lib/square.ts";

type MockFn = (...args: unknown[]) => unknown;

export const createMockClient = (
  impls: {
    checkoutCreate?: MockFn;
    locationsList?: MockFn;
    ordersGet?: MockFn;
    paymentsGet?: MockFn;
    refundsRefundPayment?: MockFn;
  } = {},
) => {
  const noop: MockFn = () => undefined;
  const checkoutCreate = spy(impls.checkoutCreate ?? noop);
  const locationsList = spy(impls.locationsList ?? noop);
  const ordersGet = spy(impls.ordersGet ?? noop);
  const paymentsGet = spy(impls.paymentsGet ?? noop);
  const refundsRefundPayment = spy(impls.refundsRefundPayment ?? noop);

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
