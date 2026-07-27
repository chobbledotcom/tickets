/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { squareApi } from "#shared/square.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  exactPayment,
  foundOrder,
  paymentResponse,
  session,
  squareLocation,
  squarePayment,
  unresolvedSquareReads,
} from "#test/shared/square-provider/fixtures.ts";
import {
  configureSquare,
  withSquareClient,
} from "#test/test-utils/square/fixtures.ts";
import { describeSquare } from "#test/test-utils/square/harness.ts";
import { withMocks } from "#test-utils/mocks.ts";

/* jscpd:ignore-end */

describeSquare(() => {
  const tenderExpected = {
    invalid: { reason: "malformed_response", status: "invalid" },
    missing: { reason: "malformed_response", status: "invalid" },
    unavailable: { reason: "provider_unavailable", status: "unavailable" },
  } as const;

  for (const input of unresolvedSquareReads) {
    test(`maps ${input.name} documented tender read`, async () => {
      await configureSquare({ locationId: squareLocation, sandbox: true });
      await withMocks(
        () => ({
          order: stub(squareApi, "readOrder", () =>
            Promise.resolve(foundOrder()),
          ),
          payment: stub(squareApi, "readPayments", () =>
            Promise.resolve(input.read),
          ),
        }),
        async ({ order, payment }) => {
          expect(
            await squarePaymentProvider.readPayment(
              await squarePayment(),
              session,
            ),
          ).toMatchObject(tenderExpected[input.name]);
          expect(order.calls).toHaveLength(1);
          expect(payment.calls).toHaveLength(1);
        },
      );
    });
  }

  for (const [name, changed, reason] of [
    ["malformed facts", { amountMoney: undefined }, "malformed_response"],
    ["a mismatched id", { id: "another-payment" }, "mismatched_id"],
  ] as const) {
    test(`rejects ${name} from the exact payment`, async () => {
      await configureSquare({ locationId: squareLocation, sandbox: true });
      await withMocks(
        () => ({
          order: stub(squareApi, "readOrder", () =>
            Promise.reject(new Error("must not read order")),
          ),
          payment: stub(squareApi, "readPayment", () =>
            Promise.resolve({
              status: "found",
              value: {
                ...paymentResponse(exactPayment.id).payment,
                ...changed,
              },
            }),
          ),
        }),
        async ({ order, payment }) => {
          expect(
            await squarePaymentProvider.readPayment(
              await squarePayment(),
              exactPayment,
            ),
          ).toMatchObject({ reason, status: "invalid" });
          expect(payment.calls).toHaveLength(1);
          expect(order.calls).toHaveLength(0);
        },
      );
    });
  }

  test("rejects a mismatched id from the requested order", async () => {
    await configureSquare({ locationId: squareLocation, sandbox: true });
    await withMocks(
      () => ({
        order: stub(squareApi, "readOrder", () =>
          Promise.resolve({
            ...foundOrder({ id: "another-order" }),
          }),
        ),
        payment: stub(squareApi, "readPayment", () =>
          Promise.reject(new Error("must not read payment")),
        ),
      }),
      async ({ order, payment }) => {
        expect(
          await squarePaymentProvider.readPayment(
            await squarePayment(),
            session,
          ),
        ).toMatchObject({ reason: "mismatched_id", status: "invalid" });
        expect(order.calls).toHaveLength(1);
        expect(payment.calls).toHaveLength(0);
      },
    );
  });

  for (const [state, status] of [
    ["OPEN", "pending"],
    ["CANCELED", "failed"],
  ] as const) {
    test(`maps ${state} order with no completed payment to ${status}`, async () => {
      await configureSquare({ locationId: squareLocation, sandbox: true });
      await withSquareClient(
        {
          ordersGet: () =>
            Promise.resolve({
              order: foundOrder({ state }).value,
            }),
          paymentsList: () =>
            Promise.resolve({
              payments: [
                {
                  ...paymentResponse(exactPayment.id).payment,
                  status: "PENDING",
                },
              ],
            }),
        },
        async () => {
          const read = await squarePaymentProvider.readPayment(
            await squarePayment(),
            session,
          );
          expect(read).toMatchObject({
            observation: { status },
            status: "found",
          });
          if (read.status !== "found")
            throw new Error("Expected found payment");
          expect("charges" in read.observation).toBe(false);
        },
      );
    });
  }
});
