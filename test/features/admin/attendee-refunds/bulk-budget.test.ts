import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { setN1GuardNotifyOnly } from "#shared/db/query-log.ts";
import { runPaymentReconciliationMaintenance } from "#shared/payment-runtime/maintenance.ts";
import {
  BULK_REFUND_FOREGROUND_REFERENCE_LIMIT,
  countExternalSubrequest,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import {
  createPaidListing,
  seedBatchAttendees,
} from "#test/lib/server-refunds-helpers.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { maintenanceContext } from "#test-utils/maintenance.ts";
import { postRefundAll, withRefundMock } from "#test-utils/refund-routes.ts";

describeWithEnv("admin bulk refund budget", { db: true }, () => {
  const errors = setupErrorSpy();
  beforeEach(() => setN1GuardNotifyOnly(true));
  afterEach(() => setN1GuardNotifyOnly(null));

  test("queues all five attendees while the bounded foreground wave stays under budget", async () => {
    expect(BULK_REFUND_FOREGROUND_REFERENCE_LIMIT).toBe(3);
    const listing = await createPaidListing({ maxAttendees: 100 });
    await seedBatchAttendees(listing, "pi_budget_", 5);

    await withRefundMock(
      () => {
        countExternalSubrequest("Stripe refund test request");
        return Promise.resolve(true);
      },
      async (refund) => {
        const response = await postRefundAll(listing);
        expect(response.status).toBe(302);
        expect(refund.calls).toHaveLength(3);
        expect(errors.calls).toHaveLength(0);
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/refund-all`,
          "3 refunds succeeded. 2 refunds will continue in the background.",
        )(response);
        const queued = await getDb().execute(
          `SELECT state, COUNT(*) AS count
             FROM payment_cases
            WHERE reason = 'admin_bulk_refund'
            GROUP BY state ORDER BY state`,
        );
        expect(queued.rows).toEqual([
          { count: 3, state: "resolved" },
          { count: 2, state: "retrying" },
        ]);
        await getDb().execute(
          "UPDATE payment_sessions SET next_reconcile_at = 0 WHERE state = 'refunding'",
        );
        const context = maintenanceContext({
          database: 21,
          external: 11,
          total: 32,
        });
        await runWithSubrequestBudget(() =>
          runPaymentReconciliationMaintenance(context),
        );
        await runWithSubrequestBudget(() =>
          runPaymentReconciliationMaintenance(context),
        );
        expect(refund.calls).toHaveLength(5);
      },
    );

    const cases = await getDb().execute(
      `SELECT state, COUNT(*) AS count
         FROM payment_cases
        WHERE reason = 'admin_bulk_refund'
        GROUP BY state ORDER BY state`,
    );
    expect(cases.rows).toEqual([{ count: 5, state: "resolved" }]);
    const payments = await getDb().execute(
      `SELECT state, COUNT(*) AS count
         FROM payment_sessions
        WHERE id LIKE 'pi_budget_%'
        GROUP BY state ORDER BY state`,
    );
    expect(payments.rows).toEqual([{ count: 5, state: "fully_refunded" }]);
  });
});
