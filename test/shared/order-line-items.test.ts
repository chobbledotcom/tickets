/** The buyer lines of one order: a package stays whole and concealed. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeOrderSummary } from "#db/attendees/balance.ts";
import { getDb } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import type { LineItem } from "#shared/line-item.ts";
import { orderLineItems } from "#shared/order-line-items.ts";
import { createMixedConcealedAttendee } from "#test/integration/balance-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";

const linesFor = async (attendeeId: number): Promise<LineItem[]> =>
  orderLineItems((await getAttendeeOrderSummary(attendeeId)).lines, "Package");

describeWithEnv("shared > order line items", { db: true }, () => {
  test("collapses a package behind its name and keeps other rows", async () => {
    const group = await createHiddenPackageGroup("Mystery Box");
    const { attendeeId } = await createMixedConcealedAttendee(group);

    expect(await linesFor(attendeeId)).toEqual([
      { name: "Mystery Box", quantity: 1 },
      { name: "Workshop Ticket", quantity: 2 },
    ]);
  });

  test("names a package row that is gone with the caller's name", async () => {
    const group = await createHiddenPackageGroup("Vanished Bundle");
    const { attendeeId } = await createMixedConcealedAttendee(group);
    await getDb().execute(
      sql`UPDATE groups SET is_package = 0 WHERE id = ${group.id}`,
    );

    expect(await linesFor(attendeeId)).toEqual([
      { name: "Package", quantity: 1 },
      { name: "Workshop Ticket", quantity: 2 },
    ]);
  });
});
