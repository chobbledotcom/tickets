import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { CHECKOUT_STAGE_TRIGGERS } from "#shared/db/migrations/schema/checkout-stage-triggers.ts";
import { syncTriggers } from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > trigger dependencies", { db: true }, () => {
  test("does not install triggers before every dependent table exists", async () => {
    for (const trigger of CHECKOUT_STAGE_TRIGGERS) {
      await getDb().execute(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    }
    await getDb().execute("DROP TABLE checkout_stage_revisions");

    await syncTriggers();

    const rows = await getDb().execute(
      "SELECT name FROM sqlite_master WHERE type = 'trigger'",
    );
    const installed = new Set(rows.rows.map((row) => String(row.name)));
    expect(installed.has("trg_checkout_stages_revision_insert")).toBe(false);
    expect(
      installed.has("trg_processed_payments_checkout_stage_claim_insert"),
    ).toBe(true);
  });
});
