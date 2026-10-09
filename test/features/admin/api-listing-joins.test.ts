/** Direct unit tests for the listing join preparation and persistence
 *  extracted from api.ts. The API integration tests in api/regressions.test.ts
 *  exercise the full request path; these test the extracted functions
 *  directly so mutation testing has a mirror for api-listing-joins.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { BlindIndex } from "#crypto/sealed.ts";
import { listingAttributeOptions } from "#db/attributes.ts";
import { type SqlStatement, withTransaction } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import { setListingGroups } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { getListingDayPrices } from "#db/listing-prices.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { bodyToUpdateInput } from "#routes/admin/api-listing-body.ts";
import {
  persistListingJoins,
  prepareChildEdges,
  prepareListingJoins,
} from "#routes/admin/api-listing-joins.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingInput } from "#test-utils/factories.ts";
import type { ListingWithCount } from "#types";

const baseInput = (
  overrides: Parameters<typeof testListingInput>[0] = {},
): ReturnType<typeof testListingInput> & {
  slug: string;
  slugIndex: BlindIndex;
} => {
  const { groupIds, ...rest } = overrides;
  return {
    ...testListingInput({ name: "Test listing", ...rest }),
    ...(groupIds !== undefined ? { groupIds } : {}),
    slug: "test-listing",
    slugIndex: "test-listing-index" as BlindIndex,
  };
};

const persistAfterRowChange = (
  listingId: number,
  statement: SqlStatement,
): Promise<void> =>
  withTransaction(async (tx) => {
    await tx.execute(statement);
    await persistListingJoins(tx, listingId, {
      attributeOptionIds: undefined,
      childEdges: null,
      dayPrices: undefined,
      groupIds: undefined,
    });
  });

/** Run an unrelated update through the API body parser the way the route
 * does: an owner session and a body without join fields. Returns the merged
 * input and the row the update read. */
const unrelatedUpdateInput = async (
  listingId: number,
): Promise<{ input: ListingInput; resolved: ListingWithCount }> => {
  const resolved = await getListingWithCount(listingId);
  if (!resolved) throw new Error(`no listing ${listingId} in the database`);
  const result = await bodyToUpdateInput(
    { description: "Unrelated edit" },
    resolved,
    { adminLevel: "owner" },
  );
  if (!result.ok) throw new Error(result.error);
  return { input: result.value, resolved };
};

describeWithEnv("api-listing-joins", { db: true }, () => {
  test("an update that omits attribute_option_ids carries undefined, not a stored snapshot", async () => {
    // persistListingJoins skips the link write for an undefined selection, so
    // an unrelated update must carry undefined — never the links re-read and
    // rewritten, which a lagging read would turn into a stale restore.
    const listing = await createTestListing({ name: "Snapshot" });
    const { input } = await unrelatedUpdateInput(listing.id);
    expect(input.attributeOptionIds).toBeUndefined();
  });

  test("refuses option ids that do not exist when the links are written", async () => {
    // The existence check shares the link write's transaction, so an option
    // deleted between the request's parse and the write cannot leave an
    // orphan id: the refusal rolls the whole write back.
    const listing = await createTestListing({ name: "Race" });
    await withTransaction(async (tx) => {
      await expect(
        persistListingJoins(tx, listing.id, {
          attributeOptionIds: [424_242],
          childEdges: null,
          dayPrices: undefined,
          groupIds: undefined,
        }),
      ).rejects.toThrow("attribute_option_ids must name existing options");
    });
    expect(await listingAttributeOptions.getIds(listing.id)).toEqual([]);
  });

  test("an update that omits group_ids carries undefined, not a stored snapshot", async () => {
    // persistListingJoins skips the link write for an undefined set, so an
    // unrelated update must carry undefined. A stored snapshot would make the
    // write rewrite the membership, and a lagging read would restore a stale
    // set. The validators still need the stored set, so it travels beside the
    // submitted one as wouldBeGroupIds.
    const group = await createTestGroup({ name: "Snapshot group" });
    const listing = await createTestListing({
      groupIds: [group.id],
      name: "Group snapshot",
    });
    const { input } = await unrelatedUpdateInput(listing.id);
    expect(input.groupIds).toBeUndefined();
    expect(input.wouldBeGroupIds).toEqual([group.id]);
  });

  test("a membership change made after an omitted-group_ids read survives the write", async () => {
    // The route reads the stored membership while it parses the body and
    // writes the joins inside the row write's transaction. A membership
    // change that lands in between must survive an update that omits
    // group_ids.
    const group = await createTestGroup({ name: "Early group" });
    const latecomer = await createTestGroup({ name: "Late group" });
    const listing = await createTestListing({
      groupIds: [group.id],
      name: "Concurrent groups",
    });
    const { input } = await unrelatedUpdateInput(listing.id);

    // Another operator's save adds a group after the update read its
    // membership.
    await setListingGroups(listing.id, [group.id, latecomer.id]);

    await withTransaction(async (tx) => {
      await persistListingJoins(tx, listing.id, prepareListingJoins(input));
    });

    expect(await listingGroups.getIds(listing.id)).toEqual([
      group.id,
      latecomer.id,
    ]);
  });

  test("child-edge validation still sees the stored groups when group_ids is omitted", async () => {
    // The hidden-package refusal proves the child-edge check reads the
    // effective set — the stored groups — not an empty one.
    const hiddenPackage = await createHiddenPackageGroup("Omitted pkg");
    const listing = await createTestListing({
      groupIds: [hiddenPackage.id],
      name: "Omitted pkg parent",
    });
    const child = await createTestListing({ name: "Omitted pkg child" });
    const { input, resolved } = await unrelatedUpdateInput(listing.id);

    const edges = await prepareChildEdges(
      { child_listing_ids: [child.id] },
      input,
      resolved,
    );

    expect("error" in edges).toBe(true);
    if ("error" in edges) {
      expect(edges.error).toBe(t("error.package_gate_in_hidden"));
    }
  });

  test("returns null child edges when child_listing_ids is omitted", async () => {
    const result = await prepareChildEdges({}, baseInput(), null);

    expect(result).toEqual({ childIds: null });
  });

  test("rejects a non-array child_listing_ids", async () => {
    const result = await prepareChildEdges(
      { child_listing_ids: "1" },
      baseInput(),
      null,
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe(
        "child_listing_ids must be an array of listing ids",
      );
    }
  });

  test("rejects a fractional child_listing_ids entry", async () => {
    const result = await prepareChildEdges(
      { child_listing_ids: [1.5] },
      baseInput(),
      null,
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe(
        "child_listing_ids must contain only positive integer listing ids",
      );
    }
  });

  test("accepts positive integer child_listing_ids and returns them cleaned", async () => {
    const child = await createTestListing({ name: "Valid child" });

    const result = await prepareChildEdges(
      { child_listing_ids: [child.id] },
      baseInput(),
      null,
    );

    expect(result).toEqual({ childIds: [child.id] });
  });

  test("rejects child edges when the listing is in a hidden package", async () => {
    const hiddenPackage = await createHiddenPackageGroup("Edge hidden pkg");
    const child = await createTestListing({ name: "Hidden pkg child" });

    const result = await prepareChildEdges(
      { child_listing_ids: [child.id] },
      baseInput({ groupIds: [hiddenPackage.id] }),
      null,
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe(t("error.package_gate_in_hidden"));
    }
  });

  test("prepareListingJoins passes groupIds through from the input", async () => {
    const group = await createTestGroup({ name: "Join group" });

    expect(prepareListingJoins(baseInput({ groupIds: [group.id] }))).toEqual({
      childEdges: null,
      dayPrices: undefined,
      groupIds: [group.id],
    });
  });

  test("persistListingJoins writes group membership and child edges in one tx", async () => {
    const parent = await createTestListing({ name: "Persist parent" });
    const child = await createTestListing({ name: "Persist child" });
    const group = await createTestGroup({ name: "Persist group" });

    await withTransaction(async (tx) => {
      await persistListingJoins(tx, parent.id, {
        attributeOptionIds: undefined,
        childEdges: [child.id],
        dayPrices: undefined,
        groupIds: [group.id],
      });
    });

    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
    expect(await listingGroups.getIds(parent.id)).toEqual([group.id]);
  });

  test("persistListingJoins leaves existing edges untouched when childEdges is null", async () => {
    const parent = await createTestListing({ name: "Skip parent" });
    const child = await createTestListing({ name: "Skip child" });
    await listingChildren.setIds(parent.id, [child.id]);

    await withTransaction(async (tx) => {
      await persistListingJoins(tx, parent.id, {
        attributeOptionIds: undefined,
        childEdges: null,
        dayPrices: undefined,
        groupIds: undefined,
      });
    });

    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("rejects a stale incoming edge after the child becomes daily", async () => {
    const parent = await createTestListing({ name: "Standard parent" });
    const child = await createTestListing({ name: "Changing child" });
    await listingChildren.setIds(parent.id, [child.id]);

    await expect(
      persistAfterRowChange(child.id, {
        args: [child.id],
        sql: "UPDATE listings SET listing_type = 'daily' WHERE id = ?",
      }),
    ).rejects.toThrow(
      t("listings_table.children_err_child_daily", { name: child.name }),
    );
    expect((await getListingWithCount(child.id))?.listing_type).toBe(
      "standard",
    );
  });

  test("rejects a stale outgoing edge after the parent becomes a renewal", async () => {
    const parent = await createTestListing({ name: "Changing parent" });
    const child = await createTestListing({ name: "Standard child" });
    await listingChildren.setIds(parent.id, [child.id]);

    await expect(
      persistAfterRowChange(parent.id, {
        args: [parent.id],
        sql: "UPDATE listings SET months_per_unit = 1 WHERE id = ?",
      }),
    ).rejects.toThrow(
      t("listings_table.children_err_parent_renewal", { name: parent.name }),
    );
    expect((await getListingWithCount(parent.id))?.months_per_unit).toBe(0);
  });

  test("persistListingJoins clears child edges when given an empty array", async () => {
    const parent = await createTestListing({ name: "Clear parent" });
    const child = await createTestListing({ name: "Clear child" });
    await listingChildren.setIds(parent.id, [child.id]);

    await withTransaction(async (tx) => {
      await persistListingJoins(tx, parent.id, {
        attributeOptionIds: undefined,
        childEdges: [],
        dayPrices: undefined,
        groupIds: undefined,
      });
    });

    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("persistListingJoins writes day prices before edge validation", async () => {
    const parent = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000 },
      durationDays: 2,
      listingType: "daily",
      name: "Changing daily parent",
    });
    const child = await createTestListing({
      durationDays: 2,
      listingType: "daily",
      name: "Two-day child",
    });

    await withTransaction((tx) =>
      persistListingJoins(tx, parent.id, {
        attributeOptionIds: undefined,
        childEdges: [child.id],
        dayPrices: { 2: 1800 },
        groupIds: undefined,
      }),
    );

    expect(await getListingDayPrices(parent.id)).toEqual({ 2: 1800 });
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });
});
