import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import {
  createTestListing,
  describeWithEnv,
  expectFlash,
  postChildren,
  updateTestListing,
} from "#test-utils";
import { makeRenewalTier } from "./helpers.ts";

type ListingConfig = Parameters<typeof createTestListing>[0];

/** Create a parent and child from their configs, save the edge, and assert the
 * resulting child set. Curried so "rejected" (no edge) and "accepted" (one edge)
 * share one implementation. */
const expectEdgeResult =
  (expected: (childId: number) => number[]) =>
  async (parentConfig: ListingConfig, childConfig: ListingConfig) => {
    const parent = await createTestListing(parentConfig);
    const child = await createTestListing(childConfig);
    await postChildren(parent.id, [child.id]);
    expect(await listingChildren.getIds(parent.id)).toEqual(expected(child.id));
  };

/** The edge is invalid, so it is dropped: the parent keeps no children. */
const expectEdgeRejected = expectEdgeResult(() => []);
/** The edge is valid, so it is saved: the parent gains exactly the child. */
const expectEdgeAccepted = expectEdgeResult((childId) => [childId]);

describeWithEnv("server > listing parents > edges", { db: true }, () => {
  test("rejects a daily child under a non-daily parent", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({
      listingType: "daily",
      name: "Daily add-on",
    });
    const res = await postChildren(parent.id, [child.id]);
    // A rejected save redirects back with an ERROR flash, not a success one.
    expectFlash(res, expect.anything(), false);
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("rejects giving children to a listing that is itself a child", async () => {
    const grandparent = await createTestListing({ name: "Grandparent" });
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({ name: "Child" });
    await postChildren(grandparent.id, [parent.id]); // parent becomes a child
    await postChildren(parent.id, [child.id]); // blocked: parent is a child
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("rejects choosing a child that is itself a parent", async () => {
    const parent = await createTestListing({ name: "Parent" });
    const child = await createTestListing({ name: "Child" });
    const grandchild = await createTestListing({ name: "Grandchild" });
    await postChildren(child.id, [grandchild.id]); // child becomes a parent
    await postChildren(parent.id, [child.id]); // blocked: child is a parent
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("rejects a renewal-tier parent", async () => {
    const parent = await createTestListing({ name: "Renewal" });
    await makeRenewalTier(parent.id);
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("rejects a renewal-tier child", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Renewal add-on" });
    await makeRenewalTier(child.id);
    await postChildren(parent.id, [child.id]);
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("rejects a daily child whose fixed duration differs from the parent", async () => {
    await expectEdgeRejected(
      { durationDays: 3, listingType: "daily", name: "3-day base" },
      { durationDays: 1, listingType: "daily", name: "1-day add-on" },
    );
  });

  test("rejects a customisable child that can't price the parent's fixed span", async () => {
    await expectEdgeRejected(
      { name: "1-day base" },
      {
        customisableDays: true,
        dayPrices: { 2: 200, 3: 300 },
        durationDays: 3,
        name: "Add-on (no 1-day price)",
      },
    );
  });

  test("accepts a customisable child that prices the parent's fixed span", async () => {
    await expectEdgeAccepted(
      { name: "1-day base" },
      {
        customisableDays: true,
        dayPrices: { 1: 100, 2: 200 },
        durationDays: 2,
        name: "Add-on (prices 1 day)",
      },
    );
  });

  test("accepts overlapping customisable parent and child day ranges", async () => {
    await expectEdgeAccepted(
      {
        customisableDays: true,
        dayPrices: { 1: 100, 2: 200, 3: 300 },
        durationDays: 3,
        name: "Flexible base",
      },
      {
        customisableDays: true,
        dayPrices: { 2: 20, 3: 30 },
        durationDays: 3,
        name: "Flexible add-on",
      },
    );
  });

  test("rejects non-overlapping customisable parent and child day ranges", async () => {
    await expectEdgeRejected(
      {
        customisableDays: true,
        dayPrices: { 1: 100 },
        durationDays: 1,
        name: "1-day flexible base",
      },
      {
        customisableDays: true,
        dayPrices: { 2: 20, 3: 30 },
        durationDays: 3,
        name: "2-3 day add-on",
      },
    );
  });

  test("accepts a plain standard child under a multi-day daily parent", async () => {
    // A one-off fee/merch add-on folds date:null and inherits no span, so it
    // is valid under any parent — including a fixed 3-day daily base.
    await expectEdgeAccepted(
      { durationDays: 3, listingType: "daily", name: "3-day base" },
      { name: "Booking fee" },
    );
  });

  test("accepts a plain standard child under a parent with no 1-day span", async () => {
    await expectEdgeAccepted(
      {
        customisableDays: true,
        dayPrices: { 2: 200, 3: 300 },
        durationDays: 3,
        name: "2-3 day flexible base",
      },
      { name: "Merch add-on" },
    );
  });

  test("accepts a daily child whose span a customisable daily parent offers", async () => {
    await expectEdgeAccepted(
      {
        customisableDays: true,
        dayPrices: { 1: 100, 2: 200, 3: 300 },
        durationDays: 3,
        listingType: "daily",
        name: "1-3 day base",
      },
      { durationDays: 2, listingType: "daily", name: "2-day add-on" },
    );
  });

  test("rejects a daily child whose span a customisable daily parent can't offer", async () => {
    await expectEdgeRejected(
      {
        customisableDays: true,
        dayPrices: { 2: 200, 3: 300 },
        durationDays: 3,
        listingType: "daily",
        name: "2-3 day base",
      },
      { durationDays: 1, listingType: "daily", name: "1-day add-on" },
    );
  });

  test("blocks a listing edit that would break an existing edge", async () => {
    const parent = await createTestListing({
      durationDays: 1,
      listingType: "daily",
      name: "Daily base",
    });
    const child = await createTestListing({
      durationDays: 1,
      listingType: "daily",
      name: "Daily add-on",
    });
    await postChildren(parent.id, [child.id]);
    // Flipping the daily parent to standard would orphan its daily child.
    await expect(
      updateTestListing(parent.id, { listingType: "standard" }),
    ).rejects.toThrow();
    const after = await getListingWithCount(parent.id);
    expect(after?.listing_type).toBe("daily");
  });

  test("allows a compatible listing edit while edges exist", async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    await postChildren(parent.id, [child.id]);
    const after = await updateTestListing(parent.id, {
      name: "Renamed base",
    });
    expect(after.name).toBe("Renamed base");
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("lets a listing that is itself a child save an empty children set", async () => {
    const grandparent = await createTestListing({ name: "Grandparent" });
    const parent = await createTestListing({ name: "Parent" });
    await postChildren(grandparent.id, [parent.id]); // parent becomes a child
    const res = await postChildren(parent.id, []); // empty no-op save
    expect(res.headers.get("set-cookie")).toContain(
      "Required%20children%20updated",
    );
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("duplicate child_listing_ids in the HTML children form collapse to one edge", async () => {
    // The same dedupe applies to repeated form values.
    const parent = await createTestListing({ name: "Base unit" });
    const child = await createTestListing({ name: "Add-on" });
    const res = await postChildren(parent.id, [child.id, child.id]);
    res.body?.cancel();
    expectFlash(res, "Required children updated");
    expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);
  });

  test("addIdsTx adds a child under each parent without disturbing others", async () => {
    const { listingChildren, listingParents } = await import(
      "#shared/db/listing-parents.ts"
    );
    const { withTransaction } = await import("#shared/db/client.ts");
    const parentA = await createTestListing({ name: "Parent A" });
    const parentB = await createTestListing({ name: "Parent B" });
    const existingChild = await createTestListing({ name: "Existing Child" });
    const newChild = await createTestListing({ name: "New Child" });
    // parentA already has a child; adding newChild under both parents must keep it.
    await listingChildren.setIds(parentA.id, [existingChild.id]);

    await withTransaction((tx) =>
      listingParents.addIdsTx(tx, newChild.id, [parentA.id, parentB.id]),
    );

    expect(await listingChildren.getIds(parentA.id)).toEqual([
      existingChild.id,
      newChild.id,
    ]);
    expect(await listingChildren.getIds(parentB.id)).toEqual([newChild.id]);
  });
});
