import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, revenueAccount } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { backfillReversesGroup } from "#accounting/reverses-group.ts";
import { postTransfers } from "#accounting/store.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import {
  forceLegLink,
  refundGroupOfBooking,
  refundLegLinks,
  seedUnattributedRefund,
  stampedReversesOf,
} from "#test/shared/accounting/reverses-group/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { tx } from "#test-utils/transfer-factory.ts";

/** A refund leg no derivation can attribute — an event group nothing derived
 *  ever lands on. `suffix` keeps several orphans' groups distinct. */
const orphanRefundLeg = (suffix = ""): TransferInput =>
  tx({
    amount: 100,
    destination: attendeeAccount(9),
    eventGroup: `evt-orphan-refund${suffix}`,
    kind: KIND.refundSale,
    reference: `orphan-refund-sale${suffix}`,
    source: revenueAccount(99),
  });

describeWithEnv("accounting > reverses-group backfill", { db: true }, () => {
  test("attributes every stored refund leg to the order it reversed", async () => {
    const bookingGroup = await seedUnattributedRefund(
      "reverses-group-order",
      7,
    );

    await backfillReversesGroup();

    expect(
      await stampedReversesOf(await refundGroupOfBooking(bookingGroup)),
    ).toEqual(new Set([bookingGroup]));
  });

  test("stamps several orders' reversals in the same run", async () => {
    const first = await seedUnattributedRefund("reverses-group-order", 7);
    const second = await seedUnattributedRefund("reverses-group-second", 8);

    await backfillReversesGroup();

    expect(await stampedReversesOf(await refundGroupOfBooking(first))).toEqual(
      new Set([first]),
    );
    expect(await stampedReversesOf(await refundGroupOfBooking(second))).toEqual(
      new Set([second]),
    );
  });

  test("is idempotent: a re-run writes nothing and still verifies", async () => {
    const bookingGroup = await seedUnattributedRefund(
      "reverses-group-rerun",
      8,
    );
    await backfillReversesGroup();

    await backfillReversesGroup();

    expect(
      await stampedReversesOf(await refundGroupOfBooking(bookingGroup)),
    ).toEqual(new Set([bookingGroup]));
  });

  test("fills only empty links, never one an operator already set", async () => {
    const bookingGroup = await seedUnattributedRefund(
      "reverses-group-preset",
      7,
    );
    const refundGroup = await refundGroupOfBooking(bookingGroup);
    const legs = await refundLegLinks(refundGroup);
    // An operator's repair holds a foreign link: the backfill must leave it
    // alone even while attributing the sibling legs it came in with.
    const repaired = legs[0]!;
    await forceLegLink(repaired.id, "evt-operator-repair");

    await backfillReversesGroup();

    const after = await refundLegLinks(refundGroup);
    expect(after.find((leg) => leg.id === repaired.id)!.reverses_group).toBe(
      "evt-operator-repair",
    );
    for (const leg of after) {
      if (leg.id === repaired.id) continue;
      expect(leg.reverses_group).toBe(bookingGroup);
    }
  });

  test("names the orphan refund event and fails rather than guess", async () => {
    await postTransfers([orphanRefundLeg()]);

    await expect(backfillReversesGroup()).rejects.toThrow(
      "refund legs with no booking order they reverse: evt-orphan-refund" +
        " — repair the orphaned refund legs or their missing order, then re-run",
    );
  });

  test("names every orphan in one comma-separated report", async () => {
    // Each orphan event group is its own post: the store refuses one call
    // carrying legs from two events.
    await postTransfers([orphanRefundLeg()]);
    await postTransfers([orphanRefundLeg("-two")]);

    await expect(backfillReversesGroup()).rejects.toThrow(
      "refund legs with no booking order they reverse: evt-orphan-refund," +
        " evt-orphan-refund-two — repair the orphaned refund legs or their" +
        " missing order, then re-run",
    );
  });
});
