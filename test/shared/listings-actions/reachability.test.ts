import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { t } from "#i18n";
import {
  deactivationOrphanedAddOnError,
  listingSaveOrphanedAddOnTx,
} from "#shared/add-on-reachability.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { storedInputFor } from "#test/shared/listings-actions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  groupRescuedChildAddOn,
  groupScopedAddOn,
  linkedParentChild,
  linkGroupAddOn,
  rescuingPageSetup,
  soloChildAddOn,
} from "#test-utils/listing-parents/helpers.ts";
import { optInAddOnForListings } from "#test-utils/modifiers.ts";

const childAddOnError = (name: string): string =>
  t("modifiers.err_child_only_addon", { name });

/** The listing save's add-on reachability check, as the row write runs it:
 * inside one write transaction, with the guard's reads through it. */
const saveGuard = async (
  listingId: number,
  overrides: Partial<ListingInput> = {},
): Promise<string | null> => {
  const input = await storedInputFor(listingId, overrides);
  return withTransaction((tx) =>
    listingSaveOrphanedAddOnTx(tx, listingId, input),
  );
};

/** Two ordinary pages rescuing one child-scoped opt-in add-on: deactivating
 * either page alone leaves the other as the add-on's reachable page. */
const twoRescuingPages = async () => {
  const { child, parent } = await linkedParentChild();
  const first = await createTestListing({ name: "First rescuing page" });
  const second = await createTestListing({ name: "Second rescuing page" });
  await optInAddOnForListings("Child-scoped extra", [
    child.id,
    first.id,
    second.id,
  ]);
  return { child, first, parent, second };
};

/** The uncommitted write one concurrent request has made, run through the
 * transaction the guard under test reads — the deterministic form of the race
 * where the first of two page-removing requests commits first. */
const deactivateListing = (
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
  listingId: number,
): Promise<unknown> =>
  tx.execute({
    args: [listingId],
    sql: "UPDATE listings SET active = 0 WHERE id = ?",
  });

describeWithEnv("listing action reachability", { db: true }, () => {
  test("rejects moving a parent away from its group-scoped child add-on", async () => {
    const { child, parent } = await groupScopedAddOn();
    await listingChildren.setIds(parent.id, [child.id]);

    await expect(saveGuard(parent.id, { groupIds: [] })).resolves.toBe(
      t("listings_table.children_err_child_addon_save", {
        addon: "Group extra",
      }),
    );
  });

  test("rejects moving a child into a group-scoped add-on its parent cannot offer", async () => {
    const { child } = await linkedParentChild();
    const group = await createTestGroup({ name: "Child Destination" });
    await linkGroupAddOn(group.id);

    await expect(saveGuard(child.id, { groupIds: [group.id] })).resolves.toBe(
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
      saveGuard(child.id, { active: true, bookableAlone: false }),
    ).resolves.toBe(childAddOnError("Child-only extra"));
  });

  test("blocks deactivating a standalone child through the save guard", async () => {
    const { child } = await soloChildAddOn();

    await expect(saveGuard(child.id, { active: false })).resolves.toBe(
      childAddOnError("Child-only extra"),
    );
  });

  test("blocks an edit that deactivates an ordinary page rescuing a child add-on", async () => {
    const { thatPage } = await rescuingPageSetup();

    await expect(saveGuard(thatPage.id, { active: false })).resolves.toBe(
      childAddOnError("Child-scoped extra"),
    );
  });

  test("blocks moving an ordinary page out of the group its child add-on needs", async () => {
    const { rescuer } = await groupRescuedChildAddOn();

    await expect(saveGuard(rescuer.id, { groupIds: [] })).resolves.toBe(
      childAddOnError("Group extra"),
    );
  });

  test("allows leaving a group when another page still offers its child add-on", async () => {
    const { group, rescuer } = await groupRescuedChildAddOn();
    await createTestListing({ groupId: group.id, name: "Second page" });

    await expect(saveGuard(rescuer.id, { groupIds: [] })).resolves.toBeNull();
  });

  test("allows saving a standalone child when its page remains available", async () => {
    const { child } = await soloChildAddOn();

    await expect(saveGuard(child.id)).resolves.toBeNull();
  });

  test("allows clearing the standalone flag on a listing that is not a child", async () => {
    const listing = await createTestListing({
      bookableAlone: true,
      name: "Ordinary Page",
    });
    await optInAddOnForListings("Own page extra", [listing.id]);

    await expect(
      saveGuard(listing.id, { bookableAlone: false }),
    ).resolves.toBeNull();
  });

  test("refuses the second of two page-removing saves inside its write transaction", async () => {
    const { first, second } = await twoRescuingPages();

    // The first save alone keeps the add-on reachable through the second page.
    await expect(saveGuard(first.id, { active: false })).resolves.toBeNull();

    await withTransaction(async (tx) => {
      // The first save's row write, still uncommitted: the second save's guard
      // runs in a later write transaction, so it must read this row through
      // its own transaction to see it.
      await deactivateListing(tx, first.id);
      await expect(
        listingSaveOrphanedAddOnTx(
          tx,
          second.id,
          await storedInputFor(second.id, { active: false }),
        ),
      ).resolves.toBe(childAddOnError("Child-scoped extra"));
    });
  });

  test("refuses a bulk deactivation whose co-rescuer a concurrent write took offline", async () => {
    const { first, second } = await twoRescuingPages();

    // Deactivating one page alone leaves the add-on reachable.
    await expect(
      deactivationOrphanedAddOnError(new Set([first.id])),
    ).resolves.toBeNull();

    await withTransaction(async (tx) => {
      await deactivateListing(tx, first.id);
      await expect(
        deactivationOrphanedAddOnError(new Set([first.id, second.id]), tx),
      ).resolves.toBe(childAddOnError("Child-scoped extra"));
    });
  });
});
