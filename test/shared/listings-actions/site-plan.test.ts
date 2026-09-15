/** A listing that assigns a built site can never share a group set with its
 *  save: the listing-side refusal on the validateListingInput path. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingGroups, setListingGroups } from "#db/groups.ts";
import { t } from "#i18n";
import { validateListingInput } from "#shared/listings-actions.ts";
import {
  inputFor,
  storedInputFor,
} from "#test/shared/listings-actions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "validateListingInput > built-site plans",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("rejects a built-site plan that joins a group", async () => {
      const group = await createTestGroup({ name: "Plan Refusal Group" });

      expect(
        await validateListingInput(
          inputFor({
            assignBuiltSite: true,
            groupIds: [group.id],
            initialSiteMonths: 1,
            name: "Refused Plan",
          }),
        ),
      ).toBe(t("error.group_member_site_plan", { name: "Refused Plan" }));
    });

    test("rejects turning on assign-built-site while the listing keeps its group", async () => {
      const group = await createTestGroup({ name: "Turn On Group" });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Turn On Candidate",
      });

      expect(
        await validateListingInput(
          await storedInputFor(listing.id, {
            assignBuiltSite: true,
            initialSiteMonths: 1,
          }),
          listing.id,
        ),
      ).toBe(t("error.group_member_site_plan", { name: "Turn On Candidate" }));
    });

    test("rejects re-saving a built-site plan that still belongs to a group", async () => {
      const group = await createTestGroup({ name: "Historical Group" });
      const listing = await createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 1,
        name: "Historical Plan",
      });
      // Manufacture the historical membership directly: the save path now
      // refuses to create it, so only a raw write can stage it.
      await setListingGroups(listing.id, [group.id]);

      expect(
        await validateListingInput(
          await storedInputFor(listing.id),
          listing.id,
        ),
      ).toBe(t("error.group_member_site_plan", { name: "Historical Plan" }));
    });

    test("allows removing every group from a built-site plan", async () => {
      const group = await createTestGroup({ name: "Removal Group" });
      const listing = await createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 1,
        name: "Removal Plan",
      });
      await setListingGroups(listing.id, [group.id]);

      expect(await listingGroups.getIds(listing.id)).toEqual([group.id]);
      await expect(
        validateListingInput(
          await storedInputFor(listing.id, { groupIds: [] }),
          listing.id,
        ),
      ).resolves.toBeNull();
    });
  },
);
