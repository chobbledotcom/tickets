import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { withTransaction } from "#shared/db/client.ts";
import {
  listingChildren,
  requireTouchingRelationshipsTx,
} from "#shared/db/listing-parents.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { standardParentWithDailyChildEdge } from "#test-utils/listing-parents/helpers.ts";

const check = (listingId: number): Promise<void> =>
  withTransaction((tx) => requireTouchingRelationshipsTx(tx, listingId));

describeWithEnv(
  "db > listing-parents > touching relationship checks",
  { db: true },
  () => {
    test("checks incoming parent edges", async () => {
      const { child } = await standardParentWithDailyChildEdge();

      await expect(check(child.id)).rejects.toThrow(
        t("listings_table.children_err_child_daily", { name: child.name }),
      );
    });

    test("checks outgoing child edges", async () => {
      const parent = await createTestListing({ name: "Renewal parent" });
      const child = await createTestListing({ name: "Standard child" });
      await listingsTable.update(parent.id, { monthsPerUnit: 1 });
      await listingChildren.setIds(parent.id, [child.id]);

      await expect(check(parent.id)).rejects.toThrow(
        t("listings_table.children_err_parent_renewal", { name: parent.name }),
      );
    });

    test("accepts a listing without edges", async () => {
      const listing = await createTestListing({ name: "Standalone listing" });

      await expect(check(listing.id)).resolves.toBeUndefined();
    });
  },
);
