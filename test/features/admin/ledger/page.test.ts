/** The ledger page module directly: the scope options its loaders bring in.
 * The full list views have their own suite; this pins the group-name and
 * group-linked-listing options the page module assembles itself. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { ledgerPageHtml } from "#test/integration/server/ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > admin ledger page", { db: true }, () => {
  test("offers every group's name as a scope option", async () => {
    await createTestGroup({ name: "Weekend runs" });

    const html = await ledgerPageHtml("/admin/ledger");

    expect(html).toContain("Weekend runs");
  });

  test("offers a group-linked listing by name in the listing scope", async () => {
    const group = await createTestGroup({ name: "Sprint week" });
    const listing = await createTestListing({ name: "Sprint night" });
    await assignListingsToGroup([listing.id], group.id);

    const html = await ledgerPageHtml("/admin/ledger?scope=listing");

    expect(html).toContain("Sprint night");
  });
});
