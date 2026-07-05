import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  edgeIncompatibilityAfterChange,
  getChildIds,
  getChildListingIds,
  getChildrenForParents,
  getParentIds,
  getParentsForChildren,
  getParentsOf,
  setChildIds,
} from "#shared/db/listing-parents.ts";
import { deleteListing } from "#shared/db/listings.ts";
import type { EdgeListing } from "#shared/listing-parents-rules.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

const ascending = (ids: number[]) => [...ids].sort((a, b) => a - b);

/** A minimal would-be listing row for edge re-validation. */
const edge = (id: number, over: Partial<EdgeListing> = {}): EdgeListing => ({
  customisable_days: false,
  day_prices: {},
  duration_days: 1,
  id,
  listing_type: "standard",
  months_per_unit: 0,
  name: "Listing",
  ...over,
});

describeWithEnv("db > listing-parents", { db: true }, () => {
  const threeListings = async () => {
    const parent = await createTestListing({ name: "Base unit" });
    const childA = await createTestListing({ name: "Add-on A" });
    const childB = await createTestListing({ name: "Add-on B" });
    return { childA, childB, parent };
  };

  describe("setChildIds / getChildIds", () => {
    test("stores and returns a parent's children, ascending", async () => {
      const { parent, childA, childB } = await threeListings();
      await setChildIds(parent.id, [childB.id, childA.id]);
      expect(await getChildIds(parent.id)).toEqual(
        ascending([childA.id, childB.id]),
      );
    });

    test("returns an empty list for a parent with no children", async () => {
      const { parent } = await threeListings();
      expect(await getChildIds(parent.id)).toEqual([]);
    });

    test("replaces the previous set (diff-save)", async () => {
      const { parent, childA, childB } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      await setChildIds(parent.id, [childB.id]);
      expect(await getChildIds(parent.id)).toEqual([childB.id]);
    });

    test("an empty set clears all children", async () => {
      const { parent, childA } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      await setChildIds(parent.id, []);
      expect(await getChildIds(parent.id)).toEqual([]);
    });
  });

  describe("getParentIds / getParentsOf", () => {
    test("reverse lookup returns the parent ids a child is offered under", async () => {
      const { parent, childA } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      expect(await getParentIds(childA.id)).toEqual([parent.id]);
    });

    test("hydrates the parent listings of a child", async () => {
      const { parent, childA } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      const parents = await getParentsOf(childA.id);
      expect(parents.map((p) => p.id)).toEqual([parent.id]);
      expect(parents.map((p) => p.name)).toEqual(["Base unit"]);
    });

    test("returns an empty array when the child has no parents", async () => {
      const { childA } = await threeListings();
      expect(await getParentsOf(childA.id)).toEqual([]);
    });

    test("drops parent edges whose listing no longer exists", async () => {
      const { childA } = await threeListings();
      const missingParentId = childA.id + 100_000;
      await setChildIds(missingParentId, [childA.id]);
      // The edge row exists but no parent listing does, so hydration drops it.
      expect(await getParentIds(childA.id)).toEqual([missingParentId]);
      expect(await getParentsOf(childA.id)).toEqual([]);
    });
  });

  describe("getChildListingIds", () => {
    test("returns the subset of ids that are children of some parent", async () => {
      const { parent, childA, childB } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      const result = await getChildListingIds([
        parent.id,
        childA.id,
        childB.id,
      ]);
      expect([...result]).toEqual([childA.id]);
    });

    test("returns an empty set for an empty input (no query)", async () => {
      expect([...(await getChildListingIds([]))]).toEqual([]);
    });
  });

  describe("getChildrenForParents", () => {
    test("groups hydrated children by parent, preserving child-id order", async () => {
      const { parent, childA, childB } = await threeListings();
      await setChildIds(parent.id, [childB.id, childA.id]);
      const map = await getChildrenForParents([parent.id]);
      // Order is by child id ascending (the query's ORDER BY), not insert order.
      expect(map.get(parent.id)?.map((c) => c.id)).toEqual(
        ascending([childA.id, childB.id]),
      );
    });

    test("loads several parents in one call (no N+1)", async () => {
      const { parent, childA, childB } = await threeListings();
      const parent2 = await createTestListing({ name: "Base unit 2" });
      await setChildIds(parent.id, [childA.id]);
      await setChildIds(parent2.id, [childB.id]);
      const map = await getChildrenForParents([parent.id, parent2.id]);
      expect(map.get(parent.id)?.map((c) => c.id)).toEqual([childA.id]);
      expect(map.get(parent2.id)?.map((c) => c.id)).toEqual([childB.id]);
    });

    test("omits parents with no children and returns empty for empty input", async () => {
      const { parent } = await threeListings();
      expect((await getChildrenForParents([parent.id])).size).toBe(0);
      expect((await getChildrenForParents([])).size).toBe(0);
    });

    test("drops a child edge whose listing no longer exists", async () => {
      const { parent, childA } = await threeListings();
      const missingChildId = childA.id + 100_000;
      await setChildIds(parent.id, [childA.id, missingChildId]);
      const map = await getChildrenForParents([parent.id]);
      expect(map.get(parent.id)?.map((c) => c.id)).toEqual([childA.id]);
    });
  });

  describe("getParentsForChildren", () => {
    test("groups hydrated parents by child, preserving parent-id order", async () => {
      const { parent, childA } = await threeListings();
      const parent2 = await createTestListing({ name: "Base unit 2" });
      await setChildIds(parent.id, [childA.id]);
      await setChildIds(parent2.id, [childA.id]);
      const map = await getParentsForChildren([childA.id]);
      expect(map.get(childA.id)?.map((p) => p.id)).toEqual(
        ascending([parent.id, parent2.id]),
      );
    });

    test("omits children with no parents and returns empty for empty input", async () => {
      const { childA } = await threeListings();
      expect((await getParentsForChildren([childA.id])).size).toBe(0);
      expect((await getParentsForChildren([])).size).toBe(0);
    });

    test("drops a parent edge whose listing no longer exists", async () => {
      const { parent, childA } = await threeListings();
      const missingParentId = childA.id + 100_000;
      await setChildIds(parent.id, [childA.id]);
      await setChildIds(missingParentId, [childA.id]);
      const map = await getParentsForChildren([childA.id]);
      // The edge to the missing parent is dropped; the real parent survives.
      expect(map.get(childA.id)?.map((p) => p.id)).toEqual([parent.id]);
    });
  });

  describe("edgeIncompatibilityAfterChange", () => {
    test("returns null when the listing has no edges", async () => {
      const { parent } = await threeListings();
      expect(await edgeIncompatibilityAfterChange(edge(parent.id))).toBeNull();
    });

    test("returns null when every touching edge stays compatible", async () => {
      const { parent, childA } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      expect(await edgeIncompatibilityAfterChange(edge(parent.id))).toBeNull();
    });

    test("flags a change that breaks the listing as a parent", async () => {
      const { parent, childA } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      const error = await edgeIncompatibilityAfterChange(
        edge(parent.id, { months_per_unit: 12 }),
      );
      expect(error).not.toBeNull();
    });

    test("flags a change that breaks the listing as a child", async () => {
      const { parent, childA } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      const error = await edgeIncompatibilityAfterChange(
        edge(childA.id, { months_per_unit: 12 }),
      );
      expect(error).not.toBeNull();
    });

    test("validates the edited listing on its own side of the edge", async () => {
      // The two cases above break symmetrically (a renewal tier is rejected on
      // either side), so they pass even if the parent/child arguments are
      // swapped. This pins the *direction*: editing the child into a daily
      // listing is invalid only as "a daily child under a (standard) parent".
      // Were the arguments swapped, the standard parent would read as a
      // compatible standard child and the breakage would vanish.
      const { parent, childA } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      const error = await edgeIncompatibilityAfterChange(
        edge(childA.id, { listing_type: "daily", name: "Daily add-on" }),
      );
      // Specifically the daily-direction error: swapping the arguments would read
      // the standard parent as a compatible standard child and return null.
      expect(error).toContain("can only be a child of another daily listing");
    });

    test("ignores edges whose opposite endpoint no longer exists", async () => {
      const { childA } = await threeListings();
      const missing = childA.id + 100_000;
      // An edge pointing at a missing child, and one pointing at a missing parent.
      await setChildIds(childA.id, [missing]);
      await setChildIds(missing, [childA.id]);
      expect(await edgeIncompatibilityAfterChange(edge(childA.id))).toBeNull();
    });
  });

  describe("deleteListing cleanup", () => {
    test("removes edges where the deleted listing is the parent", async () => {
      const { parent, childA } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      await deleteListing(parent.id);
      expect(await getParentIds(childA.id)).toEqual([]);
    });

    test("removes edges where the deleted listing is the child", async () => {
      const { parent, childA } = await threeListings();
      await setChildIds(parent.id, [childA.id]);
      await deleteListing(childA.id);
      expect(await getChildIds(parent.id)).toEqual([]);
    });
  });
});
