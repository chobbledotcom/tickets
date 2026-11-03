/** The invoice lines: a package stays whole and concealed. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeOrderSummary } from "#db/attendees/balance.ts";
import { getDb } from "#db/client.ts";
import { invoiceLines } from "#shared/invoices/lines.ts";
import { createMixedConcealedAttendee } from "#test/integration/balance-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";

describeWithEnv("shared > invoice lines", { db: true }, () => {
  test("collapses a package behind its name and keeps other rows", async () => {
    const group = await createHiddenPackageGroup("Mystery Box");
    const { attendeeId } = await createMixedConcealedAttendee(group);

    const lines = await invoiceLines(await getAttendeeOrderSummary(attendeeId));

    expect(lines).toEqual([
      { name: "Mystery Box", quantity: 1 },
      { name: "Workshop Ticket", quantity: 2 },
    ]);
  });

  test("names a package row that is gone with the generic name", async () => {
    const group = await createHiddenPackageGroup("Vanished Bundle");
    const { attendeeId } = await createMixedConcealedAttendee(group);
    await getDb().execute({
      args: [group.id],
      sql: "UPDATE groups SET is_package = 0 WHERE id = ?",
    });

    const lines = await invoiceLines(await getAttendeeOrderSummary(attendeeId));

    expect(lines).toEqual([
      { name: "Package", quantity: 1 },
      { name: "Workshop Ticket", quantity: 2 },
    ]);
  });
});
