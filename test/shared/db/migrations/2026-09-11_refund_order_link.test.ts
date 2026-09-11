import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, revenueAccount } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { bookingEventGroup, refundEventGroup } from "#accounting/mappers.ts";
import { postTransfers } from "#accounting/store.ts";
import { getDb } from "#db/client.ts";
import refundOrderLink from "#db/migrations/2026-09-11_refund_order_link.ts";
import { applySchemaChanges, syncIndexes } from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";
import { tx } from "#test-utils/transfer-factory.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const migration = () => refundOrderLink(context);

/** Seed a refunded booking order through the production mappers, then wipe the
 *  refund legs' link — the exact rows a site carries before this migration. */
const seedPreMigrationRefund = async (
  eventId: string,
  listingId: number,
): Promise<string> => {
  await postAttendeeRefund({
    attendeeId: 1,
    eventId,
    gross: 500,
    listingId,
  });
  await getDb().execute({
    args: [],
    sql: "UPDATE transfers SET reverses_group = '' WHERE kind GLOB 'refund_*'",
  });
  return await bookingEventGroup(eventId);
};

/** The `reverses_group` every refund leg of one refund event carries. */
const stampedReversesOf = async (group: string): Promise<Set<string>> => {
  const rows = await getDb().execute({
    args: [group],
    sql: "SELECT reverses_group FROM transfers WHERE event_group = ? AND kind GLOB 'refund_*'",
  });
  return new Set(rows.rows.map((row) => String(row.reverses_group)));
};

describeWithEnv("db > migrations > refund order link", { db: true }, () => {
  test("attributes every stored refund leg to the order it reversed", async () => {
    const bookingGroup = await seedPreMigrationRefund(
      "link-migration-order",
      7,
    );

    await migration().up();

    expect(
      await stampedReversesOf(await refundEventGroup(bookingGroup)),
    ).toEqual(new Set([bookingGroup]));
  });

  test("is idempotent: a re-run writes nothing and still verifies", async () => {
    const bookingGroup = await seedPreMigrationRefund(
      "link-migration-rerun",
      8,
    );
    await migration().up();

    await migration().up();

    expect(
      await stampedReversesOf(await refundEventGroup(bookingGroup)),
    ).toEqual(new Set([bookingGroup]));
  });

  test("names the orphan refund event and fails rather than guess", async () => {
    await postTransfers([
      tx({
        amount: 100,
        destination: attendeeAccount(9),
        eventGroup: "evt-orphan-refund",
        kind: KIND.refundSale,
        reference: "orphan-refund-sale",
        source: revenueAccount(99),
      }),
    ]);

    await expect(migration().up()).rejects.toThrow(
      "refund legs with no booking order they reverse: evt-orphan-refund" +
        " — repair the orphaned refund legs or their missing order, then re-run",
    );
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
