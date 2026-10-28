import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { paymentCaseTable } from "#db/migrations/schema/payments/cases.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectAccepted,
  expectRefused,
  expectRefusedAsRepeat,
} from "./refuses.ts";

/** A problem the table is happy with. What a problem may *say* is the record
 *  layer's to judge, so these rows only have to be the right shape. */
const aCase = (
  columns = "payment_id, resource, resource_index, reason, state, first_observed_at, last_observed_at, consecutive_count, evidence, revision",
  values = "'case-1', 'hyb:1:a:b:c', 'case-1-index', 'network_error', 'needs_action', 1, 1, 1, 'hyb:1:a:b:c', 1",
) => `INSERT INTO payment_cases (${columns}) VALUES (${values})`;

test("is what a problem for the owner is made of", () => {
  const [name, table] = paymentCaseTable;

  expect(name).toBe("payment_cases");
  expect(table.columns.map(([held]) => held)).toEqual([
    "id",
    "payment_id",
    "resource",
    "resource_index",
    "reason",
    "state",
    "first_observed_at",
    "last_observed_at",
    "next_reconcile_at",
    "consecutive_count",
    "alerted_at",
    "alerted_revision",
    "alert_sent_at",
    "alert_sent_revision",
    "alert_lease_token",
    "alert_lease_expires_at",
    "evidence",
    "evidence_redacted_at",
    "revision",
    "resolved_at",
  ]);
});

describeWithEnv("db > payment case rules", { db: true }, () => {
  // The one rule the table still keeps. A type says "string" while the value
  // is bytes, which is the thing no TypeScript check can see.
  for (const [name, resource] of [
    ["in plain words", "Jane Smith"],
    ["under the database owner's key", "enc:1:a:b"],
    ["behind an upper-case envelope", "HYB:1:a:b:c"],
    ["wearing an envelope with nothing in it", "hyb:1:Jane Smith"],
  ] as const) {
    test(`refuses a problem whose evidence is held ${name}`, async () => {
      await expectRefused(
        aCase(
          "payment_id, resource, resource_index, reason, state, first_observed_at, last_observed_at, consecutive_count, evidence, revision",
          `'plain', 'hyb:1:a:b:c', 'plain-index', 'network_error', 'needs_action', 1, 1, 1, '${resource}', 1`,
        ),
      );
    });
  }

  test("refuses evidence that is bytes only reading like an envelope", async () => {
    // SQLite leaves bytes alone in a TEXT column while GLOB turns them into
    // text just long enough to look at them, so bytes spelling an envelope
    // would pass and be stored as bytes that nothing can read back.
    await expectRefused({
      args: [new TextEncoder().encode("hyb:1:a:b:c")],
      sql: `INSERT INTO payment_cases
        (payment_id, resource, resource_index, reason, state,
         first_observed_at, last_observed_at, consecutive_count, evidence,
         revision)
        VALUES ('bytes', ?, 'bytes-index', 'network_error', 'needs_action',
          1, 1, 1, 'hyb:1:a:b:c', 1)`,
    });
  });

  test("accepts evidence held behind the owner's key", async () => {
    await expectAccepted(aCase());
  });

  test("starts a problem at version one when the write does not say", async () => {
    await expectAccepted(
      aCase(
        "payment_id, resource, resource_index, reason, state, first_observed_at, last_observed_at, consecutive_count, evidence",
        "'no-version', 'hyb:1:a:b:c', 'no-version-index', 'network_error', 'needs_action', 1, 1, 1, 'hyb:1:a:b:c'",
      ),
    );
    const saved = await getDb().execute(
      "SELECT revision FROM payment_cases WHERE payment_id = 'no-version'",
    );
    expect(Number(saved.rows[0]?.revision)).toBe(1);
  });

  test("refuses a second problem about the same thing on one payment", async () => {
    // Seeing the same problem again has to update the one row, or an owner is
    // asked to settle the same thing over and over.
    await expectAccepted(aCase());
    await expectRefusedAsRepeat(
      aCase(
        "payment_id, resource, resource_index, reason, state, first_observed_at, last_observed_at, consecutive_count, evidence, revision",
        "'case-1', 'hyb:1:a:b:c', 'case-1-index', 'timeout', 'retrying', 2, 2, 2, 'hyb:1:a:b:c', 2",
      ),
    );
  });
});
