import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadGroupOverviewPanel } from "#routes/admin/group-page-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withTestSession } from "#test-utils/session.ts";

describeWithEnv("the group Overview tab's ledger link", { db: true }, () => {
  test("stays off unless the caller says the viewer may open the ledger", async () => {
    const group = await createTestGroup({ name: "Ledger Group" });
    // A paid member shows the money block the link sits in.
    await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      unitPrice: 500,
    });
    const ledgerHref = `/admin/ledger?group=${group.id}`;

    // The ledger is owner-only, so the safe default hides its link.
    const [withDefault, forOwner] = await withTestSession(() =>
      Promise.all([
        loadGroupOverviewPanel(group),
        loadGroupOverviewPanel(group, true),
      ]),
    );
    expect(String(withDefault)).not.toContain(ledgerHref);
    expect(String(forOwner)).toContain(ledgerHref);
  });
});
