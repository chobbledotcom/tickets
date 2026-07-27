/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ProviderInvalidReason } from "#shared/payment-state/observation.ts";
import { squareApi } from "#shared/square.ts";
import type { SquareOrder, SquarePayment } from "#shared/square-payments.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  exactPayment,
  orderResponse,
  paymentResponse,
  session,
  squareLocation,
  squarePayment,
  squareReadWith,
  unresolvedSquareReads,
} from "#test/shared/square-provider/fixtures.ts";
import {
  configureSquare,
  withSquareClient,
} from "#test/test-utils/square/fixtures.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";
import { withMocks } from "#test-utils/mocks.ts";

/* jscpd:ignore-end */

const validOrder = (): SquareOrder => orderResponse().order;

const validPayment = (): SquarePayment => paymentResponse("pay-typed").payment;

const expectInvalidPayment = async (
  payment: SquarePayment,
  reason: ProviderInvalidReason,
): Promise<void> => {
  await configureSquare({ locationId: squareLocation, sandbox: true });
  await withSquareClient(
    {
      ordersGet: () => Promise.resolve({ order: validOrder() }),
      paymentsList: () => Promise.resolve({ payments: [payment] }),
    },
    async () => {
      expect(
        await squarePaymentProvider.readPayment(await squarePayment(), session),
      ).toMatchObject({ reason, status: "invalid" });
    },
  );
};

const expectInvalidOrder = async (
  order: SquareOrder,
  reason: ProviderInvalidReason,
): Promise<void> => {
  await configureSquare({ locationId: squareLocation, sandbox: true });
  await withSquareClient(
    { ordersGet: () => Promise.resolve({ order }) },
    async () => {
      expect(
        await squarePaymentProvider.readPayment(await squarePayment(), session),
      ).toMatchObject({ reason, status: "invalid" });
    },
  );
};

describeSquare(() => {
  const invalidPayments: Array<{
    name: string;
    reason: ProviderInvalidReason;
    value: SquarePayment;
  }> = [
    {
      name: "zero completed amount",
      reason: "malformed_response",
      value: {
        ...validPayment(),
        amountMoney: { amount: 0n, currency: "GBP" },
      },
    },
    {
      name: "missing money",
      reason: "malformed_response",
      value: { ...validPayment(), amountMoney: undefined },
    },
    {
      name: "missing amount",
      reason: "malformed_response",
      value: { ...validPayment(), amountMoney: { currency: "GBP" } },
    },
    {
      name: "missing currency",
      reason: "malformed_response",
      value: { ...validPayment(), amountMoney: { amount: 1_000n } },
    },
    {
      name: "negative amount",
      reason: "malformed_response",
      value: {
        ...validPayment(),
        amountMoney: { amount: -1n, currency: "GBP" },
      },
    },
    {
      name: "unsafe amount",
      reason: "malformed_response",
      value: {
        ...validPayment(),
        amountMoney: {
          amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          currency: "GBP",
        },
      },
    },
    {
      name: "invalid currency",
      reason: "malformed_response",
      value: {
        ...validPayment(),
        amountMoney: { amount: 1_000n, currency: "gbp" },
      },
    },
    {
      name: "different currency",
      reason: "malformed_response",
      value: {
        ...validPayment(),
        amountMoney: { amount: 1_000n, currency: "USD" },
      },
    },
    {
      name: "different location",
      reason: "mismatched_account",
      value: { ...validPayment(), locationId: "another-location" },
    },
    {
      name: "different order parent",
      reason: "mismatched_parent",
      value: { ...validPayment(), orderId: "another-order" },
    },
    {
      name: "invalid creation time",
      reason: "malformed_response",
      value: { ...validPayment(), createdAt: "not-a-time" },
    },
    {
      name: "unknown status",
      reason: "malformed_response",
      value: { ...validPayment(), status: "UNKNOWN" },
    },
    {
      name: "missing refunded amount",
      reason: "malformed_response",
      value: { ...validPayment(), refundedMoney: { currency: "GBP" } },
    },
    {
      name: "negative refunded amount",
      reason: "malformed_response",
      value: {
        ...validPayment(),
        refundedMoney: { amount: -1n, currency: "GBP" },
      },
    },
    {
      name: "refunded amount above the charge",
      reason: "malformed_response",
      value: {
        ...validPayment(),
        refundedMoney: { amount: 1_001n, currency: "GBP" },
      },
    },
    {
      name: "refunded amount in another currency",
      reason: "malformed_response",
      value: {
        ...validPayment(),
        refundedMoney: { amount: 1n, currency: "USD" },
      },
    },
  ];

  for (const input of invalidPayments) {
    test(`rejects a completed payment with ${input.name}`, () =>
      expectInvalidPayment(input.value, input.reason));
  }

  const invalidOrders: Array<{
    name: string;
    reason: ProviderInvalidReason;
    value: SquareOrder;
  }> = [
    {
      name: "another location",
      reason: "mismatched_account",
      value: { ...validOrder(), locationId: "another-location" },
    },
    {
      name: "invalid creation time",
      reason: "malformed_response",
      value: { ...validOrder(), createdAt: "not-a-time" },
    },
    {
      name: "unknown state",
      reason: "malformed_response",
      value: { ...validOrder(), state: "UNKNOWN" },
    },
    {
      name: "negative total",
      reason: "malformed_response",
      value: { ...validOrder(), totalMoney: { amount: -1n, currency: "GBP" } },
    },
    {
      name: "unsafe total",
      reason: "malformed_response",
      value: {
        ...validOrder(),
        totalMoney: {
          amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
          currency: "GBP",
        },
      },
    },
    {
      name: "invalid currency",
      reason: "malformed_response",
      value: {
        ...validOrder(),
        totalMoney: { amount: 1_000n, currency: "gbp" },
      },
    },
  ];

  for (const input of invalidOrders) {
    test(`rejects an order with ${input.name}`, () =>
      expectInvalidOrder(input.value, input.reason));
  }

  const unresolvedExpected = {
    invalid: { reason: "mismatched_id", status: "invalid" },
    missing: { reason: "not_found", status: "missing" },
    unavailable: { reason: "provider_unavailable", status: "unavailable" },
  } as const;

  for (const input of unresolvedSquareReads) {
    for (const [resource, requested] of [
      ["exact payment", exactPayment],
      ["order", session],
    ] as const) {
      test(`maps ${input.name} ${resource} read`, async () => {
        await configureSquare({ locationId: squareLocation, sandbox: true });
        await withMocks(
          () => ({
            order: stub(squareApi, "readOrder", () =>
              Promise.resolve(input.read),
            ),
            payment: stub(
              squareApi,
              resource === "exact payment" ? "readPayment" : "readPayments",
              () => Promise.resolve(input.read),
            ),
          }),
          async ({ order, payment: readPayment }) => {
            expect(
              await squarePaymentProvider.readPayment(
                await squarePayment(),
                requested,
              ),
            ).toMatchObject(unresolvedExpected[input.name]);
            expect(readPayment.calls).toHaveLength(
              resource === "exact payment" ? 1 : 0,
            );
            expect(order.calls).toHaveLength(resource === "order" ? 1 : 0);
          },
        );
      });
    }
  }

  test("rejects a stored payment from another mode", async () => {
    await configureSquare({ locationId: squareLocation, sandbox: true });
    const payment = await squarePayment();
    expect(
      await squarePaymentProvider.readPayment(
        { ...payment, mode: "live" },
        session,
      ),
    ).toMatchObject({ reason: "mismatched_account", status: "invalid" });
  });

  test("rejects a completed order with no completed payment", async () => {
    expect(
      await squareReadWith({
        ordersGet: () =>
          Promise.resolve({ order: { ...validOrder(), state: "COMPLETED" } }),
        paymentsList: () =>
          Promise.resolve({
            payments: [{ ...validPayment(), status: "PENDING" }],
          }),
      }),
    ).toMatchObject({
      reason: "missing_documented_resource",
      status: "invalid",
    });
  });

  test("returns a retry after the bounded payment-list pages are exhausted", async () => {
    await configureSquare({ locationId: squareLocation, sandbox: true });
    let page = 0;
    await withSquareClient(
      {
        ordersGet: () =>
          Promise.resolve({
            order: {
              ...validOrder(),
              tenders: Array.from({ length: 41 }, (_, index) => ({
                paymentId: `payment-${index}`,
              })),
            },
          }),
        paymentsList: () =>
          Promise.resolve({ cursor: `cursor-${page++}`, payments: [] }),
      },
      async ({ paymentsList }) => {
        expect(
          await squarePaymentProvider.readPayment(
            await squarePayment(),
            session,
          ),
        ).toMatchObject({
          reason: "provider_unavailable",
          status: "unavailable",
        });
        expect(paymentsList.calls).toHaveLength(8);
      },
    );
  });
});
