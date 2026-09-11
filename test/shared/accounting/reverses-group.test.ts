import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, revenueAccount } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { bookingEventGroup, refundEventGroup } from "#accounting/mappers.ts";
import { backfillReversesGroup } from "#accounting/reverses-group.ts";
import { postTransfers } from "#accounting/store.ts";
import { getDb } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";
import { tx } from "#test-utils/transfer-factory.ts";

/** Seed a refunded booking order through the production mappers, then wipe the
 *  refund legs' link — the exact rows a site carries before the backfill. */
const seedUnattributedRefund = async (
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

describeWithEnv("accounting > reverses-group backfill", { db: true }, () => {
  test("attributes every stored refund leg to the order it reversed", async () => {
    const bookingGroup = await seedUnattributedRefund(
      "reverses-group-order",
      7,
    );

    await backfillReversesGroup();

    expect(
      await stampedReversesOf(await refundEventGroup(bookingGroup)),
    ).toEqual(new Set([bookingGroup]));
  });

  test("is idempotent: a re-run writes nothing and still verifies", async () => {
    const bookingGroup = await seedUnattributedRefund(
      "reverses-group-rerun",
      8,
    );
    await backfillReversesGroup();

    await backfillReversesGroup();

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

    await expect(backfillReversesGroup()).rejects.toThrow(
      "refund legs with no booking order they reverse: evt-orphan-refund" +
        " — repair the orphaned refund legs or their missing order, then re-run",
    );
  });
});
