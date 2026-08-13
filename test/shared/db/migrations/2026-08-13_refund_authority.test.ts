import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { loadMigrations } from "#shared/db/migrations/context.ts";
import { useTransactionalDb } from "#test-utils/ledger.ts";

const MIGRATIONS = await loadMigrations();
const migration = MIGRATIONS.find(
  (entry) => entry.id === "2026-08-13_refund_authority",
);
if (!migration) {
  throw new Error("Migration 2026-08-13_refund_authority is not registered");
}

describe("db > migrations > refund authority", () => {
  useTransactionalDb();

  test("refuses to reinterpret a populated dormant charge table", async () => {
    await getDb().execute({
      args: [
        "hyb:1:a:b:c",
        "reference-one",
        JSON.stringify({
          evidenceRevision: 1,
          kind: "ready",
          local: { kind: "not_due" },
          nextActionAt: 10,
          readyAt: 1,
          request: {
            capability: "keyed",
            generation: 1,
            identityIndex: "request-one",
            replayUntil: 100,
          },
        }),
      ],
      sql: `INSERT INTO payment_charges
        (provider, provider_reference, reference_index,
         capability, captured_amount, currency,
         refunded_amount, refund_state, refund_state_name,
         refund_local_state, next_refund_action_at, refund_revision,
         created_at, updated_at, observed_at)
        VALUES ('stripe', ?, ?, 'keyed', 100,
          'GBP', 0, ?, 'ready', 'not_due', 10, 1, 1, 1, 1)`,
    });

    await expect(migration.up()).rejects.toThrow(
      "payment_charges is not empty",
    );
  });
});
