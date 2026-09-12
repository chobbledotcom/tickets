import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import refundOrderLink from "#db/migrations/2026-09-11_refund_order_link.ts";
import {
  applySchemaChanges,
  getExistingColumns,
  syncIndexes,
} from "#db/migrations/schema-sync.ts";
import {
  expectStampedToBooking,
  seedUnattributedRefund,
} from "#test/shared/accounting/reverses-group/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext, indexExists } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const migration = () => refundOrderLink(context);

describeWithEnv("db > migrations > refund order link", { db: true }, () => {
  test("applies the schema and the backfill in one up()", async () => {
    // The backfill's own behaviour is pinned at its mirror,
    // test/shared/accounting/reverses-group.test.ts; this side pins that the
    // migration owns the schema objects and runs the backfill with them.
    const bookingGroup = await seedUnattributedRefund("migration-order", 7);
    await getDb().execute("DROP INDEX IF EXISTS idx_transfers_reverses_group");
    await getDb().execute("ALTER TABLE transfers DROP COLUMN reverses_group");

    await migration().up();

    expect((await getExistingColumns("transfers")).has("reverses_group")).toBe(
      true,
    );
    expect(await indexExists("idx_transfers_reverses_group")).toBe(true);
    await expectStampedToBooking(bookingGroup);
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
      "Add transfers.reverses_group. It names the booking order each refund " +
        "leg reverses. Backfill it onto every stored refund leg, so the " +
        "refunded status can ask per booking order instead of per attendee " +
        "and listing. mapRefund is the only poster of refund legs. It stamps " +
        "the link going forward. The backfill derives the same attribution " +
        "for historical legs. It refuses loudly on any refund leg no " +
        "derivation can attribute.",
    );
  });
});
