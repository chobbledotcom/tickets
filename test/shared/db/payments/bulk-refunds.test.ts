import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  queueBulkRefundPayments,
  requireBulkRefundAction,
  resolveQueuedBulkRefundPayments,
} from "#shared/db/payments/bulk-refunds.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { storedStripePayment } from "#test-utils/stripe/provider-fixtures.ts";

describeWithEnv("db > payments > bulk refunds", { db: true }, () => {
  test("asks the owner to look at a refund that could not be finished", async () => {
    const recorded = await requireBulkRefundAction(storedStripePayment());

    expect(recorded.paymentCase).toMatchObject({
      reason: "admin_bulk_refund",
      state: "needs_action",
    });
    // Nothing is scheduled: the money moves again only when the owner says so.
    expect(recorded.paymentCase.nextReconcileAt).toBeNull();
  });

  test("refuses to touch a payment with no checkout to refund against", () => {
    // Every refund is filed against the checkout the money went through. A
    // payment without one cannot be matched to anything at the provider, and
    // this stops before any database work starts.
    expect(() =>
      resolveQueuedBulkRefundPayments([storedStripePayment({ session: null })]),
    ).toThrow("has no provider session");
  });
  test("asks the database nothing when no payments were named", async () => {
    // Queueing an empty selection must not open a write, so an owner who
    // picks nothing does not spend one of the request's database calls.
    const used = await runWithSubrequestBudget(async () => {
      await queueBulkRefundPayments([]);
      return getSubrequestUsage().database;
    });

    expect(used).toBe(0);
  });
});
