import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { PaymentCharge } from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import { resolvePayment } from "#shared/payment-state/resolve.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { constructTestSquareWebhook } from "#shared/square-webhook.ts";
import {
  configureSquare,
  withSquareClient,
} from "#test/lib/square/fixtures.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import { PAYMENT_TIME } from "#test/shared/db/payments/fixtures.ts";
import { paymentCharge } from "#test/shared/payment-runtime/fixtures.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import {
  orderResponse,
  paymentResponse,
  session,
  squarePayment,
} from "./fixtures.ts";

describeSquare(() => {
  test("returns typed charge facts for a completed payment", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    await withSquareClient(
      {
        ordersGet: () => Promise.resolve(orderResponse()),
        paymentsList: () =>
          Promise.resolve({ payments: [paymentResponse("pay-typed").payment] }),
      },
      async () => {
        const read = await squarePaymentProvider.readPayment(
          await squarePayment(),
          session,
        );

        expect(read).toMatchObject({
          observation: {
            charges: [
              {
                captured: { amount: 1_000, currency: "GBP" },
                resource: {
                  id: "pay-typed",
                  kind: "square_payment",
                  parentId: session.id,
                  provider: "square",
                },
              },
            ],
            status: "paid",
          },
          status: "found",
        });
      },
    );
  });

  test("returns every completed split tender for shared conflict resolution", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    await withSquareClient(
      {
        ordersGet: () => Promise.resolve(orderResponse(["pay-one", "pay-two"])),
        paymentsList: () =>
          Promise.resolve({
            payments: ["pay-one", "pay-two"].map((id) => ({
              ...paymentResponse(id).payment,
              amountMoney: {
                amount: BigInt(id === "pay-one" ? 400 : 600),
                currency: "GBP",
              },
            })),
          }),
      },
      async () => {
        const read = await squarePaymentProvider.readPayment(
          await squarePayment(),
          session,
        );
        expect(read).toMatchObject({
          observation: {
            charges: [
              { captured: { amount: 600 }, resource: { id: "pay-two" } },
              { captured: { amount: 400 }, resource: { id: "pay-one" } },
            ],
          },
          status: "found",
        });
        expect(resolvePayment(read)).toMatchObject({
          issue: { kind: "multiple_charges" },
          status: "conflict",
        });
      },
    );
  });

  test("validates signed metadata before offering legacy adoption", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    await withSquareClient(
      {
        ordersGet: () =>
          Promise.resolve({
            order: {
              ...orderResponse().order,
              metadata: signedMeta(
                {
                  email: "legacy-square@example.com",
                  items: singleItem(7, 1, 1_000),
                  name: "Legacy Square buyer",
                },
                1_000,
              ),
            },
          }),
        paymentsList: () =>
          Promise.resolve({ payments: [paymentResponse("pay-typed").payment] }),
      },
      async () => {
        expect(
          await squarePaymentProvider.readPayment(null, session),
        ).toMatchObject({
          observation: {
            bookingIntent: { email: "legacy-square@example.com" },
            ownership: { method: "signed" },
          },
          status: "found",
        });
      },
    );
  });

  test("reads the exact webhook payment and every order tender", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    const tenderIds = Array.from({ length: 12 }, (_, index) => `old-${index}`);
    await withSquareClient(
      {
        ordersGet: () => Promise.resolve(orderResponse(tenderIds)),
        paymentsGet: () =>
          Promise.resolve({
            payment: {
              ...paymentResponse("pay-webhook").payment,
              status: "COMPLETED",
            },
          }),
        paymentsList: () =>
          Promise.resolve({
            payments: tenderIds.map((id) => ({
              ...paymentResponse(id).payment,
              status: "PENDING",
            })),
          }),
      },
      async ({ paymentsGet, paymentsList }) => {
        const requested = {
          id: "pay-webhook",
          kind: "square_payment" as const,
          parentId: session.id,
          provider: "square" as const,
        };
        const read = await squarePaymentProvider.readPayment(
          await squarePayment(),
          requested,
        );
        expect(read).toMatchObject({
          observation: { charges: [{ resource: { id: "pay-webhook" } }] },
          requested,
          status: "found",
        });
        expect(paymentsGet.calls[0]?.args).toEqual([
          { paymentId: "pay-webhook" },
        ]);
        expect(paymentsList.calls).toHaveLength(1);
      },
    );
  });

  for (const status of ["APPROVED", "FAILED"] as const) {
    test(`returns a typed ${status} fact without reading the order`, async () => {
      await configureSquare({ locationId: "square-location", sandbox: true });
      await withSquareClient(
        {
          ordersGet: () => Promise.reject(new Error("must not read order")),
          paymentsGet: () =>
            Promise.resolve({
              payment: { ...paymentResponse("pay-exact").payment, status },
            }),
        },
        async ({ ordersGet }) => {
          const read = await squarePaymentProvider.readPayment(
            await squarePayment(),
            {
              id: "pay-exact",
              kind: "square_payment",
              parentId: session.id,
              provider: "square",
            },
          );
          expect(read).toMatchObject({
            observation: {
              status: status === "FAILED" ? "failed" : "pending",
            },
            status: "found",
          });
          expect(read.status === "found" && "charges" in read.observation).toBe(
            false,
          );
          expect(ordersGet.calls).toHaveLength(0);
        },
      );
    });
  }

  test("returns the exact pending refund resource", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    const charge: PaymentCharge = {
      captured: { amount: 1_000, currency: "GBP" },
      createdAt: PAYMENT_TIME,
      id: 1,
      observedAt: PAYMENT_TIME,
      paymentId: "square-local",
      pendingRefund: null,
      pendingRefundIdempotencyKey: "refund-key",
      providerReference: {
        id: "pay-typed",
        kind: "square_payment",
        parentId: session.id,
        provider: "square",
      },
      refunded: { amount: 0, currency: "GBP" },
      refundState: "requested",
      updatedAt: PAYMENT_TIME,
    };
    await withSquareClient(
      {
        refundsRequestRefund: () =>
          Promise.resolve({
            amount: { amount: 1_000, currency: "GBP" },
            id: "refund-pending",
            paymentId: "pay-typed",
            status: "PENDING",
          }),
      },
      async () => {
        expect(
          await squarePaymentProvider.refundCharge(charge, "refund-key"),
        ).toEqual({
          amount: { amount: 1_000, currency: "GBP" },
          refund: {
            id: "refund-pending",
            kind: "square_refund",
            parentId: "pay-typed",
            provider: "square",
          },
          status: "pending",
        });
      },
    );
  });

  test("polls a persisted Square refund without sending another request", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    const pendingRefund = {
      id: "refund-existing",
      kind: "square_refund" as const,
      parentId: "pay-typed",
      provider: "square" as const,
    };
    await withSquareClient(
      {
        refundsGet: () =>
          Promise.resolve({
            amount: { amount: 600, currency: "GBP" },
            id: "refund-existing",
            paymentId: "pay-typed",
            status: "COMPLETED",
          }),
        refundsRequestRefund: () => Promise.reject(new Error("must not post")),
      },
      async ({ refundsGet, refundsRequestRefund }) => {
        expect(
          await squarePaymentProvider.refundCharge(
            paymentCharge({
              captured: { amount: 1_000, currency: "GBP" },
              pendingRefund,
              providerReference: {
                id: "pay-typed",
                kind: "square_payment",
                parentId: session.id,
                provider: "square",
              },
              refunded: { amount: 400, currency: "GBP" },
              refundState: "pending",
            }),
            "existing-key",
          ),
        ).toEqual({
          amount: { amount: 1_000, currency: "GBP" },
          refund: pendingRefund,
          status: "completed",
        });
        expect(refundsGet.calls[0]?.args).toEqual([
          { refundId: "refund-existing" },
        ]);
        expect(refundsRequestRefund.calls).toHaveLength(0);
      },
    );
  });

  test("parses a signed Square notice into its exact payment resource", async () => {
    const secret = "square-provider-notice";
    const webhookUrl = "https://example.com/payment/webhook";
    await settings.update.square.webhookSignatureKey(secret);
    const event = {
      data: {
        object: {
          id: "pay-notice",
          order_id: session.id,
          status: "COMPLETED",
        },
      },
      event_id: "evt-square-provider",
      type: "payment.updated",
    };
    const { payload, signature } = await constructTestSquareWebhook(
      event,
      secret,
      webhookUrl,
    );

    expect(
      await squarePaymentProvider.verifyWebhookSignature(
        payload,
        signature,
        webhookUrl,
        new TextEncoder().encode(payload),
      ),
    ).toEqual({
      notice: {
        eventId: "evt-square-provider",
        resource: {
          id: "pay-notice",
          kind: "square_payment",
          parentId: session.id,
          provider: "square",
        },
        type: "payment.updated",
      },
      valid: true,
    });
  });
});
