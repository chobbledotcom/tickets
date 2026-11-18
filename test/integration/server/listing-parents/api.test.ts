import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingGroups } from "#db/groups/table.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { getAllListings, getListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  apiCreateListing,
  linkedParentChild,
  parentAndChild,
} from "#test-utils/listing-parents/helpers.ts";
import { postChildren } from "#test-utils/parents.ts";
import { apiRequest } from "#test-utils/session.ts";

/** A standard "Base unit" parent and a daily "Daily add-on" child — a daily
 * child under a standard parent is an invalid edge. */
const standardParentDailyChild = async () => ({
  child: await createTestListing({
    listingType: "daily",
    name: "Daily add-on",
  }),
  parent: await createTestListing({ name: "Base unit" }),
});

/** Save one listing write through the admin API and read its answer. */
const putListing = (id: number, body: Record<string, unknown>) =>
  apiRequest(`/api/admin/listings/${id}`, { body, method: "PUT" });

/** Save one listing write through the admin API and read the edges it stores. */
const expectApiStoresChildren = async (
  parent: { id: number },
  body: Record<string, unknown>,
  children: readonly number[],
): Promise<void> => {
  await assertJson(putListing(parent.id, body), 200);
  expect(await listingChildren.getIds(parent.id)).toEqual([...children]);
};

/** Save one listing write through the admin API and read its refusal and the
 *  edges the parent keeps. */
const expectApiRefusesChildren = async (
  parent: { id: number },
  body: Record<string, unknown>,
  children: readonly number[],
  error?: string,
): Promise<void> => {
  await assertJson(
    putListing(parent.id, body),
    400,
    error === undefined
      ? undefined
      : (json) => {
          expect(json.error).toBe(error);
        },
  );
  expect(await listingChildren.getIds(parent.id)).toEqual([...children]);
};

/** Save a child list through the admin API and read its refusal. A refused
 *  save stores no edge. */
const expectApiRefusesChildIds = (
  parent: { id: number },
  ids: readonly (number | string)[],
  error: string,
): Promise<void> =>
  expectApiRefusesChildren(parent, { child_listing_ids: ids }, [], error);

describeWithEnv("server > listing parents > admin API", { db: true }, () => {
  test("admin API create writes child edges", async () => {
    const child = await createTestListing({ name: "Add-on" });
    const parentId = await apiCreateListing({
      child_listing_ids: [child.id],
      max_attendees: 10,
      name: "Base unit",
    });
    expect(await listingChildren.getIds(parentId)).toEqual([child.id]);
  });

  test("admin API update changes child edges", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const first = await createTestListing({ name: "Add-on A" });
    const second = await createTestListing({ name: "Add-on B" });
    await postChildren(parent.id, [first.id]);
    await expectApiStoresChildren(parent, { child_listing_ids: [second.id] }, [
      second.id,
    ]);
  });

  test("admin API can leave a hidden package while adding children", async () => {
    const group = await createTestGroup({
      hidePackageListings: true,
      isPackage: true,
      name: "Hidden package",
    });
    const parent = await createTestListing({
      groupId: group.id,
      name: "Leaving package",
    });
    const child = await createTestListing({ name: "New child" });

    await expectApiStoresChildren(
      parent,
      { child_listing_ids: [child.id], group_ids: [] },
      [child.id],
    );
    expect(await listingGroups.getIds(parent.id)).toEqual([]);
  });

  test("admin API rejects a non-numeric child id entry without clearing edges", async () => {
    // A JSON client sending a stringified id (e.g. `"oops"`, or `"7"`) must fail
    // closed with a 400 — never be silently filtered out, which could shrink the
    // array to empty and turn a gated parent into a standalone listing.
    const { parent, child } = await linkedParentChild();
    await expectApiRefusesChildren(
      parent,
      { child_listing_ids: [child.id, "oops"] },
      [child.id],
      "child_listing_ids must contain only positive integer listing ids",
    );
  });

  test("admin API refuses an unknown NUMERIC child id", async () => {
    // An unknown numeric id is a positive integer, so the body read accepts it.
    // The edge check then refuses it: dropping it would store a smaller child
    // set than the client sent.
    const { parent, child } = await parentAndChild();
    await expectApiRefusesChildIds(
      parent,
      [child.id, parent.id + 9999],
      t("listings_table.children_err_missing"),
    );
  });

  test("admin API refuses a child id that names the listing itself", async () => {
    const { parent, child } = await parentAndChild();
    await expectApiRefusesChildIds(
      parent,
      [parent.id, child.id],
      t("listings_table.children_err_self", { name: parent.name }),
    );
  });

  test("admin API rejects a string child_listing_ids without clearing edges", async () => {
    const { parent, child } = await linkedParentChild();
    await expectApiRefusesChildren(
      parent,
      { child_listing_ids: "not-an-array" },
      [child.id],
      "child_listing_ids must be an array of listing ids",
    );
  });

  test("admin API rejects an object child_listing_ids without clearing edges", async () => {
    const { parent, child } = await linkedParentChild();
    await expectApiRefusesChildren(
      parent,
      { child_listing_ids: { [child.id]: true } },
      [child.id],
    );
  });

  test("admin API leaves edges untouched when child_listing_ids is omitted", async () => {
    const { parent, child } = await linkedParentChild();
    await expectApiStoresChildren(parent, { name: "Renamed base" }, [child.id]);
  });

  test("admin API clears edges when child_listing_ids is an empty array", async () => {
    const { parent } = await linkedParentChild();
    await expectApiStoresChildren(parent, { child_listing_ids: [] }, []);
  });

  test("admin API rejects an invalid edge with no write", async () => {
    const { parent, child } = await standardParentDailyChild();
    await expectApiRefusesChildIds(
      parent,
      [child.id],
      t("listings_table.children_err_child_daily", { name: "Daily add-on" }),
    );
  });

  test("admin API PUT rejecting an invalid child does NOT persist the rename", async () => {
    // The child-edge validation runs BEFORE the row write, so a rejected edge
    // leaves no partial change: the rename in the same PUT must not stick.
    // A daily child under a standard parent is an invalid edge.
    const { parent, child } = await standardParentDailyChild();
    await expectApiRefusesChildren(
      parent,
      { child_listing_ids: [child.id], name: "Renamed base" },
      [],
    );
    // Neither the edge nor the rename persisted.
    expect((await getListingWithCount(parent.id))?.name).toBe("Base unit");
  });

  test("admin API POST rejecting an invalid child creates NO listing row", async () => {
    // On create the child-edge validation runs before the insert, so a rejected
    // edge must leave no orphan listing row behind.
    const child = await createTestListing({
      listingType: "daily",
      name: "Daily add-on",
    });
    const before = (await getAllListings()).length;
    await assertJson(
      apiRequest("/api/admin/listings", {
        body: {
          child_listing_ids: [child.id],
          max_attendees: 10,
          name: "Base unit",
        },
        method: "POST",
      }),
      400,
    );
    const after = await getAllListings();
    expect(after.length).toBe(before);
    expect(after.some((l) => l.name === "Base unit")).toBe(false);
  });

  test("duplicate child_listing_ids collapse to a single edge with no error", async () => {
    // `validateChildEdges` keeps duplicate ids unless deduped, so `[child,child]`
    // would make `setChildIds` insert two `(parent, child)` rows and violate the
    // unique index — and on the API side-effect path that happens after the row
    // write (a partial change). The cleaned set must be unique.
    const { parent, child } = await parentAndChild();
    await expectApiStoresChildren(
      parent,
      { child_listing_ids: [child.id, child.id] },
      [child.id],
    );
  });
});
