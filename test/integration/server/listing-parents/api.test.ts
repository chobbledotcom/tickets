import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingGroups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import {
  apiCreateListing,
  linkedParentChild,
  parentAndChild,
} from "#test/test-utils/listing-parents/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
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
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [second.id] },
        method: "PUT",
      }),
      200,
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([second.id]);
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

    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id], group_ids: [] },
        method: "PUT",
      }),
      200,
    );
    expect(await listingGroups.getIds(parent.id)).toEqual([]);
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("admin API rejects a non-numeric child id entry without clearing edges", async () => {
    // A JSON client sending a stringified id (e.g. `"oops"`, or `"7"`) must fail
    // closed with a 400 — never be silently filtered out, which could shrink the
    // array to empty and turn a gated parent into a standalone listing.
    const { parent, child } = await linkedParentChild();
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id, "oops"] },
        method: "PUT",
      }),
      400,
      (json) => {
        expect(json.error).toBe(
          "child_listing_ids must contain only positive integer listing ids",
        );
      },
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("admin API keeps known ids and drops an unknown NUMERIC child id", async () => {
    // An unknown numeric id is still a positive integer, so the array is accepted
    // (200) and validateChildEdges drops the unknown id downstream.
    const { parent, child } = await parentAndChild();
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id, parent.id + 9999] },
        method: "PUT",
      }),
      200,
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("admin API rejects a string child_listing_ids without clearing edges", async () => {
    const { parent, child } = await linkedParentChild();
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: "not-an-array" },
        method: "PUT",
      }),
      400,
      (json) => {
        expect(json.error).toBe(
          "child_listing_ids must be an array of listing ids",
        );
      },
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("admin API rejects an object child_listing_ids without clearing edges", async () => {
    const { parent, child } = await linkedParentChild();
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: { [child.id]: true } },
        method: "PUT",
      }),
      400,
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("admin API leaves edges untouched when child_listing_ids is omitted", async () => {
    const { parent, child } = await linkedParentChild();
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { name: "Renamed base" },
        method: "PUT",
      }),
      200,
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("admin API clears edges when child_listing_ids is an empty array", async () => {
    const { parent } = await linkedParentChild();
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [] },
        method: "PUT",
      }),
      200,
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("admin API rejects an invalid edge with no write", async () => {
    const { parent, child } = await standardParentDailyChild();
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id] },
        method: "PUT",
      }),
      400,
      (json) => {
        expect(typeof json.error).toBe("string");
      },
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("admin API PUT rejecting an invalid child does NOT persist the rename", async () => {
    // The child-edge validation runs BEFORE the row write, so a rejected edge
    // leaves no partial change: the rename in the same PUT must not stick.
    // A daily child under a standard parent is an invalid edge.
    const { parent, child } = await standardParentDailyChild();
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id], name: "Renamed base" },
        method: "PUT",
      }),
      400,
    );
    // Neither the edge nor the rename persisted.
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
    expect((await getListingWithCount(parent.id))?.name).toBe("Base unit");
  });

  test("admin API POST rejecting an invalid child creates NO listing row", async () => {
    // On create the child-edge validation runs before the insert, so a rejected
    // edge must leave no orphan listing row behind.
    const { getAllListings } = await import("#shared/db/listings/records.ts");
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
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { child_listing_ids: [child.id, child.id] },
        method: "PUT",
      }),
      200,
    );
    // Exactly one edge, no error, no partial write.
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });
});
