import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  edgeIncompatibilityAfterChange,
  getChildIds,
  getChildListingIds,
  getParentIds,
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
