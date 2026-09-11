import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import refundOrderLink from "#db/migrations/2026-09-11_refund_order_link.ts";
import {
  applySchemaChanges,
  getExistingColumns,
  syncIndexes,
} from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext, indexExists } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const migration = () => refundOrderLink(context);

describeWithEnv("db > migrations > refund order link", { db: true }, () => {
  test("applies the column and the index together with the backfill", async () => {
    // The backfill itself is pinned at its mirror,
    // test/shared/accounting/reverses-group.test.ts; this side pins that the
    // migration owns the schema objects and runs them in one up().
    await getDb().execute("DROP INDEX IF EXISTS idx_transfers_reverses_group");
    await getDb().execute("ALTER TABLE transfers DROP COLUMN reverses_group");

    await migration().up();

    expect((await getExistingColumns("transfers")).has("reverses_group")).toBe(
      true,
    );
    expect(await indexExists("idx_transfers_reverses_group")).toBe(true);
  });

  test("declares every object it owns", () => {
    // Anything left off this list is never verified, so a partial upgrade
    // would record itself as applied.
    expect(migration().requires).toEqual({
      columns: { transfers: ["reverses_group"] },
      indexes: ["idx_transfers_reverses_group"],
    });
    expect(migration().id).toBe("2026-09-11_refund_order_link");
    expect(migration().description).toBe(
      "Add transfers.reverses_group — the booking-order event group each refund " +
        "leg reverses — and backfill it onto every stored refund leg, so the " +
        "refunded-status projection can ask per booking order instead of per " +
        "attendee and listing. mapRefund is the only poster of refund legs and " +
        "stamps the link going forward; the backfill re-derives the same " +
        "attribution for historical legs and refuses loudly on any refund leg " +
        "no derivation can attribute.",
    );
  });
});
