import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import {
  type RefundPaymentInput,
  SquareHttpError,
  type SquareRefund,
} from "#shared/square-client.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  configureSquare,
  withSquareClient,
} from "#test/lib/square/fixtures.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import { paymentCharge } from "#test/shared/payment-runtime/fixtures.ts";

const chargeResource = {
  id: "square-payment",
  kind: "square_payment" as const,
  parentId: "square-order",
  provider: "square" as const,
};

const partialCharge = () =>
  paymentCharge({
    captured: { amount: 1_000, currency: "GBP" },
    providerReference: chargeResource,
    refunded: { amount: 400, currency: "GBP" },
  });

const pendingRefund = {
  id: "square-refund",
  kind: "square_refund" as const,
  parentId: chargeResource.id,
  provider: "square" as const,
};

const refundResponse = (
  status: SquareRefund["status"],
  changes: Partial<SquareRefund> = {},
): SquareRefund => ({
  amount: { amount: 600, currency: "GBP" },
  id: pendingRefund.id,
  paymentId: chargeResource.id,
  status,
  ...changes,
});

const pendingCharge = () =>
  paymentCharge({
    ...partialCharge(),
    pendingRefund,
    refundState: "pending",
  });

describeSquare(() => {
  test("requests only the amount remaining after a confirmed partial refund", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    await withSquareClient(
      {
        refundsRequestRefund: () =>
          Promise.resolve(refundResponse("COMPLETED")),
      },
      async ({ refundsRequestRefund }) => {
        expect(
          await squarePaymentProvider.refundCharge(
            partialCharge(),
            "square-local-refund",
          ),
        ).toEqual({
          amount: { amount: 1_000, currency: "GBP" },
          refund: pendingRefund,
          status: "completed",
        });
        const request = refundsRequestRefund.calls[0]
          ?.args[0] as RefundPaymentInput;
        expect(request.amountMoney).toEqual({
          amount: 600n,
          currency: "GBP",
        });
        expect(request.idempotencyKey).toBe("square-local-refund");
        expect(request.paymentId).toBe(chargeResource.id);
      },
    );
  });

  for (const [name, refund] of [
    [
      "different payment parent",
      refundResponse("PENDING", {
        id: "wrong-parent",
        paymentId: "another-payment",
      }),
    ],
    [
      "different amount",
      refundResponse("PENDING", {
        amount: { amount: 599, currency: "GBP" },
        id: "wrong-amount",
      }),
    ],
    [
      "different currency",
      refundResponse("PENDING", {
        amount: { amount: 600, currency: "USD" },
        id: "wrong-currency",
      }),
    ],
  ] as const) {
    test(`rejects an initial refund response with a ${name}`, async () => {
      await configureSquare({ locationId: "square-location", sandbox: true });
      await withSquareClient(
        { refundsRequestRefund: () => Promise.resolve(refund) },
        async () => {
          await expect(
            squarePaymentProvider.refundCharge(
              partialCharge(),
              "square-local-refund",
            ),
          ).rejects.toThrow();
        },
      );
    });
  }

  test("polls the exact persisted pending refund without another POST", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    await withSquareClient(
      {
        refundsGet: () => Promise.resolve(refundResponse("PENDING")),
        refundsRequestRefund: () => Promise.reject(new Error("must not post")),
      },
      async ({ refundsGet, refundsRequestRefund }) => {
        expect(
          await squarePaymentProvider.refundCharge(
            pendingCharge(),
            "unused-key",
          ),
        ).toEqual({
          amount: { amount: 1_000, currency: "GBP" },
          refund: pendingRefund,
          status: "pending",
        });
        expect(refundsGet.calls[0]?.args).toEqual([
          { refundId: pendingRefund.id },
        ]);
        expect(refundsRequestRefund.calls).toHaveLength(0);
      },
    );
  });

  for (const status of ["REJECTED", "FAILED"] as const) {
    test(`returns failed when the exact refund is ${status}`, async () => {
      await configureSquare({ locationId: "square-location", sandbox: true });
      await withSquareClient(
        {
          refundsGet: () => Promise.resolve(refundResponse(status)),
        },
        async () => {
          expect(
            await squarePaymentProvider.refundCharge(
              pendingCharge(),
              "unused-key",
            ),
          ).toMatchObject({
            amount: { amount: 400, currency: "GBP" },
            reason: "provider_failed",
            refund: pendingRefund,
            status: "failed",
          });
        },
      );
    });
  }

  test("does not request another refund when the charge is fully refunded", async () => {
    await settings.update.square.accessToken("");
    expect(
      await squarePaymentProvider.refundCharge(
        paymentCharge({
          ...partialCharge(),
          refunded: { amount: 1_000, currency: "GBP" },
        }),
        "unused-key",
      ),
    ).toEqual({
      amount: { amount: 1_000, currency: "GBP" },
      status: "completed",
    });
  });

  test("returns failed when Square cannot create the refund", async () => {
    await settings.update.square.accessToken("");
    expect(
      await squarePaymentProvider.refundCharge(
        partialCharge(),
        "square-local-refund",
      ),
    ).toEqual({
      amount: { amount: 400, currency: "GBP" },
      reason: "provider_failed",
      status: "failed",
    });
  });

  test("returns failed for an initial failed refund", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    await withSquareClient(
      {
        refundsRequestRefund: () => Promise.resolve(refundResponse("FAILED")),
      },
      async () => {
        expect(
          await squarePaymentProvider.refundCharge(
            partialCharge(),
            "square-local-refund",
          ),
        ).toEqual({
          amount: { amount: 400, currency: "GBP" },
          reason: "provider_failed",
          refund: pendingRefund,
          status: "failed",
        });
      },
    );
  });

  test("keeps a persisted refund pending while Square is unavailable", async () => {
    await settings.update.square.accessToken("");
    expect(
      await squarePaymentProvider.refundCharge(pendingCharge(), "unused-key"),
    ).toEqual({
      amount: { amount: 1_000, currency: "GBP" },
      refund: pendingRefund,
      status: "pending",
    });
  });

  const malformedPersistedRefunds: ReadonlyArray<
    readonly [string, Partial<SquareRefund>]
  > = [
    ["different payment parent", { paymentId: "another-payment" }],
    ["different amount", { amount: { amount: 599, currency: "GBP" } }],
    ["different currency", { amount: { amount: 600, currency: "USD" } }],
  ];

  for (const [name, refund] of malformedPersistedRefunds) {
    test(`fails a persisted refund with a ${name}`, async () => {
      await configureSquare({ locationId: "square-location", sandbox: true });
      await withSquareClient(
        {
          refundsGet: () => Promise.resolve(refundResponse("PENDING", refund)),
        },
        async () => {
          expect(
            await squarePaymentProvider.refundCharge(
              pendingCharge(),
              "unused-key",
            ),
          ).toMatchObject({
            amount: { amount: 400, currency: "GBP" },
            reason: "provider_failed",
            status: "failed",
          });
        },
      );
    });
  }

  for (const [name, getRefund] of [
    [
      "missing",
      () => Promise.reject(new SquareHttpError(404, "missing refund")),
    ],
    [
      "mismatched",
      () =>
        Promise.resolve(refundResponse("PENDING", { id: "another-refund" })),
    ],
  ] as const) {
    test(`fails when the persisted refund is ${name}`, async () => {
      await configureSquare({ locationId: "square-location", sandbox: true });
      await withSquareClient({ refundsGet: getRefund }, async () => {
        expect(
          await squarePaymentProvider.refundCharge(
            pendingCharge(),
            "unused-key",
          ),
        ).toMatchObject({ reason: "provider_failed", status: "failed" });
      });
    });
  }

  test("fails loudly when a pending charge has no refund resource", async () => {
    await expect(
      squarePaymentProvider.refundCharge(
        paymentCharge({ ...partialCharge(), refundState: "pending" }),
        "unused-key",
      ),
    ).rejects.toThrow();
  });
});
