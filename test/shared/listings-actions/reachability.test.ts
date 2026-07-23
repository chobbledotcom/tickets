import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { listingChildren } from "#shared/db/listing-parents.ts";
import {
  deactivationOrphanedAddOnError,
  validateListingInput,
} from "#shared/listings-actions.ts";
import {
  groupScopedAddOn,
  linkedParentChild,
  linkGroupAddOn,
  rescuingPageSetup,
  soloChildAddOn,
} from "#test/lib/server-listing-parents/helpers.ts";
import { storedInputFor } from "#test/shared/listings-actions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { optInAddOnForListings } from "#test-utils/modifiers.ts";

const childAddOnError = (name: string): string =>
  t("modifiers.err_child_only_addon", { name });

describeWithEnv("listing action reachability", { db: true }, () => {
  test("rejects moving a parent away from its group-scoped child add-on", async () => {
    const { child, parent } = await groupScopedAddOn();
    await listingChildren.setIds(parent.id, [child.id]);

    await expect(
      validateListingInput(
        await storedInputFor(parent.id, { groupIds: [] }),
        parent.id,
      ),
    ).resolves.toBe(
      t("listings_table.children_err_child_addon_save", {
        addon: "Group extra",
      }),
    );
  });

  test("rejects moving a child into a group-scoped add-on its parent cannot offer", async () => {
    const { child } = await linkedParentChild();
    const group = await createTestGroup({ name: "Child Destination" });
    await linkGroupAddOn(group.id);

    await expect(
      validateListingInput(
        await storedInputFor(child.id, { groupIds: [group.id] }),
        child.id,
      ),
    ).resolves.toBe(
      t("listings_table.children_err_child_addon_save", {
        addon: "Group extra",
      }),
    );
  });

  test("blocks deactivating a standalone child that is its add-on's only page", async () => {
    const { child } = await soloChildAddOn();

    await expect(
      deactivationOrphanedAddOnError(new Set([child.id])),
    ).resolves.toBe(childAddOnError("Child-only extra"));
  });

  test("blocks clearing the standalone flag when it is the add-on's only page", async () => {
    const { child } = await soloChildAddOn();

    await expect(
      validateListingInput(
        await storedInputFor(child.id, {
          active: true,
          bookableAlone: false,
        }),
        child.id,
      ),
    ).resolves.toBe(childAddOnError("Child-only extra"));
  });

  test("blocks deactivating a standalone child through listing validation", async () => {
    const { child } = await soloChildAddOn();

    await expect(
      validateListingInput(
        await storedInputFor(child.id, { active: false }),
        child.id,
      ),
    ).resolves.toBe(childAddOnError("Child-only extra"));
  });

  test("blocks an edit that deactivates an ordinary page rescuing a child add-on", async () => {
    const { thatPage } = await rescuingPageSetup();

    await expect(
      validateListingInput(
        await storedInputFor(thatPage.id, { active: false }),
        thatPage.id,
      ),
    ).resolves.toBe(childAddOnError("Child-scoped extra"));
  });

  test("allows saving a standalone child when its page remains available", async () => {
    const { child } = await soloChildAddOn();

    await expect(
      validateListingInput(await storedInputFor(child.id), child.id),
    ).resolves.toBeNull();
  });

  test("allows clearing the standalone flag on a listing that is not a child", async () => {
    const listing = await createTestListing({
      bookableAlone: true,
      name: "Ordinary Page",
    });
    await optInAddOnForListings("Own page extra", [listing.id]);

    await expect(
      validateListingInput(
        await storedInputFor(listing.id, { bookableAlone: false }),
        listing.id,
      ),
    ).resolves.toBeNull();
  });
});
