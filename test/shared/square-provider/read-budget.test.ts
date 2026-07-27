import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { getOpenPaymentCases } from "#shared/db/payments/cases.ts";
import { reconcilePayment } from "#shared/payment-runtime/process.ts";
import {
  BUNNY_SUBREQUEST_LIMIT,
  countExternalSubrequest,
  getSubrequestUsage,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import {
  configureSquare,
  withSquareClient,
} from "#test/lib/square/fixtures.ts";
import { describeSquare } from "#test/lib/square/harness.ts";
import {
  orderResponse,
  paymentResponse,
  squarePayment,
} from "#test/shared/square-provider/fixtures.ts";

describeSquare(() => {
  test("persists all forty tender facts as one conflict under budget", async () => {
    await configureSquare({ locationId: "square-location", sandbox: true });
    const payment = await squarePayment();
    const ids = Array.from({ length: 40 }, (_, index) => `pay-${index}`);
    let usage = { database: 0, external: 0, total: 0 };

    await withSquareClient(
      {
        ordersGet: () => {
          countExternalSubrequest("Square order test read");
          return Promise.resolve(orderResponse(ids));
        },
        paymentsList: () => {
          countExternalSubrequest("Square payment-list test read");
          return Promise.resolve({
            payments: ids.map((id) => ({
              ...paymentResponse(id).payment,
              amountMoney: { amount: 25n, currency: "GBP" },
            })),
          });
        },
      },
      async ({ paymentsGet, paymentsList }) => {
        await runWithSubrequestBudget(async () => {
          const outcome = await reconcilePayment(
            "square",
            { id: payment.id, kind: "local" },
            () => Promise.reject(new Error("A conflict must not be fulfilled")),
          );
          expect(outcome).toMatchObject({
            payment: { state: "needs_action" },
            status: "conflict",
          });
          usage = getSubrequestUsage();
        });
        expect(paymentsGet.calls).toHaveLength(0);
        expect(paymentsList.calls).toHaveLength(1);
      },
    );

    expect(usage.external).toBe(2);
    expect(usage.total).toBeLessThan(BUNNY_SUBREQUEST_LIMIT);
    expect(
      (
        await getDb().execute(
          "SELECT reason, state FROM payment_cases WHERE payment_id = ?",
          [payment.id],
        )
      ).rows,
    ).toEqual([{ reason: "multiple_charges", state: "needs_action" }]);
    const [paymentCase] = await getOpenPaymentCases();
    const evidence = paymentCase?.evidence;
    if (
      evidence === undefined ||
      !("kind" in evidence) ||
      evidence.kind !== "provider_read"
    ) {
      throw new Error("Expected exhaustive Square provider evidence");
    }
    const charges =
      evidence.read.status === "found"
        ? evidence.read.observation.charges
        : undefined;
    expect(charges?.map((charge) => charge.resource.id)).toEqual(
      ids.toReversed(),
    );
  });
});
