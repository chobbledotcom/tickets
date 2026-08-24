/** validateListingGroupMembershipTx's child-state override: a caller that is
 *  clearing the listing's children in the same write vouches for that with
 *  `hasChildren: false`, and the validation must trust the voucher instead of
 *  the stored edges it is about to remove. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { validateListingGroupMembershipTx } from "#db/groups/membership.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "db > groups > membership child-state override",
  { db: true },
  () => {
    const hiddenPackageParent = async (name: string) => {
      const group = await createHiddenPackageGroup(name);
      const parent = await createTestListing({ name: `${name} parent` });
      const child = await createTestListing({ name: `${name} child` });
      await listingChildren.setIds(parent.id, [child.id]);
      return { group, parent };
    };

    test("trusts a caller that vouches the children are being cleared", async () => {
      const { group, parent } = await hiddenPackageParent("Vouched clear");

      const validation = await withTransaction((tx) =>
        validateListingGroupMembershipTx(tx)(parent.id, [group.id], false),
      );

      expect(validation.error).toBeNull();
    });

    test("reads the stored child edges when no caller vouches", async () => {
      const { group, parent } = await hiddenPackageParent("Stored edges");

      const validation = await withTransaction((tx) =>
        validateListingGroupMembershipTx(tx)(parent.id, [group.id]),
      );

      expect(validation.error).toBe(
        t("error.package_member_gates_children_hidden", { name: parent.name }),
      );
    });
  },
);
