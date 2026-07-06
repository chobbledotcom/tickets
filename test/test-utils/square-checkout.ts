/**
 * Square SDK mocking helpers. The Square tests stub `squareApi.getSquareClient`
 * to hand the code under test a fake SDK client whose `checkout`, `orders`,
 * `payments`, `refunds`, and `locations` calls are spies. `createMockClient`
 * builds that fake; `withSquareClient` / `withMockSquareClient` install it for
 * the duration of a test body and restore afterwards.
 */

import { spy, stub } from "@std/testing/mock";
import { type SquareClient, squareApi } from "#shared/square.ts";
import { withMocks } from "#test-utils/mocks.ts";

/** A stubbed SDK method: takes any args, returns whatever the test resolves. */
export type MockFn = (...args: unknown[]) => unknown;

/** The fake client plus the spies for each call, as inferred from
 *  {@link createMockClient} — so each spy field keeps its exact `spy(...)` type
 *  instead of the wrong overload `ReturnType<typeof spy>` picks. */
export type SquareClientMock = ReturnType<typeof createMockClient>;

/** Build a fake Square SDK client whose methods are spies. Pass an
 *  implementation for each call the test exercises; the rest are no-ops. */
export const createMockClient = (
  impls: {
    checkoutCreate?: MockFn;
    ordersGet?: MockFn;
    paymentsGet?: MockFn;
    refundsRefundPayment?: MockFn;
    locationsList?: MockFn;
  } = {},
) => {
  // A method the test supplied gets its spy; the rest get a bare `spy()` whose
  // no-op has no body of ours to run (a shared `noop` arrow would count as an
  // unreachable line for the methods the test never calls).
  const spied = (fn?: MockFn) => (fn ? spy(fn) : spy());
  const checkoutCreate = spied(impls.checkoutCreate);
  const ordersGet = spied(impls.ordersGet);
  const paymentsGet = spied(impls.paymentsGet);
  const refundsRefundPayment = spied(impls.refundsRefundPayment);
  const locationsList = spied(impls.locationsList);

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

/** A `withMocks` setup thunk that points `squareApi.getSquareClient` at
 *  `client`. Use as the first argument to `withMocks` when the test body needs
 *  to keep its existing shape. */
export const useSquareClient = (client: SquareClient) => () =>
  stub(squareApi, "getSquareClient", () => Promise.resolve(client));

/** Make `squareApi.getSquareClient` resolve to `client` for the duration of
 *  `body`, then restore the real implementation. */
export const withSquareClient = (
  client: SquareClient,
  body: () => void | Promise<void>,
): Promise<void> =>
  withMocks(
    () => stub(squareApi, "getSquareClient", () => Promise.resolve(client)),
    body,
  );

/** Build a fake client from `impls`, install it, and run `body` with the mock
 *  handle (so the body can read its spies), restoring afterwards. */
export const withMockSquareClient = (
  impls: Parameters<typeof createMockClient>[0],
  body: (mock: SquareClientMock) => void | Promise<void>,
): Promise<void> => {
  const mock = createMockClient(impls);
  return withSquareClient(mock.client, () => body(mock));
};
