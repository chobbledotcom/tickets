import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { paymentTables } from "#db/migrations/schema/payments/index.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete payment aggregate schema declaration exact", async () => {
  expect(await jsonHash(paymentTables)).toBe(
    "d747ecf9924c30ecbaccd2c4e1f6020fa8bd8931c97975f576a50caf222f4d60",
  );
});

describeWithEnv("db > payment aggregate indexes", { db: true }, () => {
  test("creates every aggregate lookup index", async () => {
    const result = await getDb().execute(
      `SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name IN ('payment_sessions', 'payment_charges', 'payment_cases',
                            'payment_case_decisions', 'payment_completion_effects',
                            'payment_completion_deliveries', 'refund_confirmations',
                            'refund_confirmation_references')
          AND name NOT LIKE 'sqlite_autoindex%'
        ORDER BY name`,
    );
    expect(result.rows.map((row) => row.name)).toEqual([
      "idx_payment_case_decisions_retry",
      "idx_payment_case_decisions_revision",
      "idx_payment_cases_alert",
      "idx_payment_cases_payment_resource",
      "idx_payment_cases_reconcile",
      "idx_payment_cases_redaction",
      "idx_payment_charges_callback_replay",
      "idx_payment_charges_next_action",
      "idx_payment_charges_reference",
      "idx_payment_charges_refund_state",
      "idx_payment_completion_deliveries_pending",
      "idx_payment_completion_deliveries_unique",
      "idx_payment_completion_effects_unique",
      "idx_payment_sessions_attendee",
      "idx_payment_sessions_reconcile",
      "idx_payment_sessions_redaction",
      "idx_payment_sessions_reference",
      "idx_refund_confirmation_references_unique",
      "idx_refund_confirmations_attendee",
    ]);
  });
});
