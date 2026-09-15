/** The built-site plan membership rule: a listing that assigns a site on
 *  booking can join no group at all — ordinary or package — and can keep
 *  saving only by leaving every group. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction, writeRowInTransaction } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { setListingGroups, setListingGroupsTx } from "#db/groups.ts";
import { listingsTable } from "#db/listings/records.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { sitePlanMemberError } from "#shared/package-membership.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  listingGroupIdsOf,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { Group } from "#types";

/** A built-site plan listing created through the real admin form. */
const createPlanListing = (name: string) =>
  createTestListing({ assignBuiltSite: true, initialSiteMonths: 1, name });

/** The shared tail of every "the group write refused the plan" case: the join
 *  reports the shared refusal and no membership row lands. */
const refusePlanJoin = async (name: string, group: Group): Promise<void> => {
  const plan = await createPlanListing(name);
  expect(await assignListingsToGroup([plan.id], group.id)).toBe(
    sitePlanMemberError(plan.name),
  );
  expect(await listingGroupIdsOf(plan.id)).toEqual([]);
};

describeWithEnv(
  "db > groups > built-site plan membership",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("an ordinary group refuses a built-site plan listing", async () => {
      const group = await createTestGroup({ name: "Ordinary Plan Target" });
      await refusePlanJoin("Refused Plan", group);
    });

    test("a package group refuses a built-site plan listing", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Package Plan Target",
      });
      await refusePlanJoin("Package Refused Plan", group);
    });

    test("a listing's own save refuses to join it to a group", async () => {
      const group = await createTestGroup({ name: "Own Save Group" });
      const plan = await createPlanListing("Own Save Plan");

      await expect(
        writeRowInTransaction(
          await listingsTable.updateStatement!(plan.id, { active: true }),
          plan.id,
          (tx, id) => setListingGroupsTx(tx, id, [group.id]),
        ),
      ).rejects.toBeInstanceOf(TransactionValidationError);
      expect(await listingGroupIdsOf(plan.id)).toEqual([]);
    });

    test("a listing's own save refuses to create a membership", async () => {
      const group = await createTestGroup({ name: "Historical Keep Group" });
      const plan = await createPlanListing("Kept Plan");
      expect(await listingGroupIdsOf(plan.id)).toEqual([]);

      await expect(
        withTransaction((tx) => setListingGroupsTx(tx, plan.id, [group.id])),
      ).rejects.toMatchObject({
        message: sitePlanMemberError(plan.name),
      });
    });

    test("a built-site plan keeps leaving every group open", async () => {
      const group = await createTestGroup({ name: "Leave Group" });
      const plan = await createPlanListing("Leaving Plan");
      // Manufacture the historical membership directly: no save path can
      // create it any more, so only a raw write can stage it.
      await setListingGroups(plan.id, [group.id]);
      expect(await listingGroupIdsOf(plan.id)).toEqual([group.id]);

      await withTransaction((tx) => setListingGroupsTx(tx, plan.id, []));

      expect(await listingGroupIdsOf(plan.id)).toEqual([]);
    });

    test("a group holding a stored plan refuses the batch add of a normal listing", async () => {
      const group = await createTestGroup({ name: "Stored Plan Hold" });
      const plan = await createPlanListing("Held Plan");
      // No save path can create this membership, so stage it raw.
      await setListingGroups(plan.id, [group.id]);

      const normal = await createTestListing({ name: "Held Group Joiner" });

      expect(await assignListingsToGroup([normal.id], group.id)).toBe(
        sitePlanMemberError(plan.name),
      );
      expect(await listingGroupIdsOf(normal.id)).toEqual([]);
    });

    test("a group holding a stored plan refuses a normal listing's own save", async () => {
      const group = await createTestGroup({ name: "Stored Plan Save Hold" });
      const plan = await createPlanListing("Saved Beside Plan");
      await setListingGroups(plan.id, [group.id]);

      const normal = await createTestListing({ name: "Save Held Joiner" });

      await expect(
        withTransaction((tx) => setListingGroupsTx(tx, normal.id, [group.id])),
      ).rejects.toMatchObject({
        message: sitePlanMemberError(plan.name),
      });
      expect(await listingGroupIdsOf(normal.id)).toEqual([]);
    });
  },
);
