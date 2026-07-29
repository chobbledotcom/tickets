import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { paymentTables } from "#shared/db/migrations/schema/payments/index.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete payment aggregate schema declaration exact", async () => {
  expect(await jsonHash(paymentTables)).toBe(
    "bdf87c7b379e243c4d5c323da0ada4bb4af7a6810c4309e9077636c9fe585f24",
  );
});

describeWithEnv("db > payment aggregate indexes", { db: true }, () => {
  test("creates every aggregate lookup index", async () => {
    const result = await getDb().execute(
      `SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name IN ('payment_sessions', 'payment_charges', 'payment_cases',
                            'payment_case_decisions', 'payment_completion_effects',
                            'payment_completion_deliveries')
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
      "idx_payment_charges_legacy_source",
      "idx_payment_charges_payment_reference",
      "idx_payment_charges_pending_refund",
      "idx_payment_charges_reference",
      "idx_payment_completion_deliveries_pending",
      "idx_payment_completion_deliveries_unique",
      "idx_payment_completion_effects_unique",
      "idx_payment_sessions_attendee",
      "idx_payment_sessions_reconcile",
      "idx_payment_sessions_redaction",
      "idx_payment_sessions_reference",
    ]);
  });
});
