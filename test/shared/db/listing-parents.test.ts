import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  anyNonStandaloneChild,
  edgeIncompatibilityAfterChange,
  firstTouchingEdgeError,
  hydrateListingLinks,
  listingChildren,
  listingIdsWithLinks,
  listingParents,
  type TouchingEdge,
} from "#shared/db/listing-parents.ts";
import { deleteListing } from "#shared/db/listings/delete.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import type { EdgeListing } from "#shared/listing-parents-rules.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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

  const linkChildToParents = async (
    childId: number,
    parentIds: readonly number[],
  ): Promise<void> => {
    for (const parentId of parentIds) {
      await listingChildren.setIds(parentId, [childId]);
    }
  };

  const hydratedListings = async (
    side: typeof listingChildren,
    ids: readonly number[],
  ) => (await hydrateListingLinks(side, ids)).listingsByKey;

  describe("setChildIds / getChildIds", () => {
    test("stores and returns a parent's children, ascending", async () => {
      const { parent, childA, childB } = await threeListings();
      await listingChildren.setIds(parent.id, [childB.id, childA.id]);
      expect(await listingChildren.getIds(parent.id)).toEqual(
        ascending([childA.id, childB.id]),
      );
    });

    test("returns an empty list for a parent with no children", async () => {
      const { parent } = await threeListings();
      expect(await listingChildren.getIds(parent.id)).toEqual([]);
    });

    test("replaces the previous set (diff-save)", async () => {
      const { parent, childA, childB } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      await listingChildren.setIds(parent.id, [childB.id]);
      expect(await listingChildren.getIds(parent.id)).toEqual([childB.id]);
    });

    test("dedupes a repeated child id to a single edge", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [
        childA.id,
        childA.id,
        childA.id,
      ]);
      expect(await listingChildren.getIds(parent.id)).toEqual([childA.id]);
      // And the reverse lookup sees exactly one edge too.
      expect(await listingParents.getIds(childA.id)).toEqual([parent.id]);
    });

    test("an empty set clears all children", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      await listingChildren.setIds(parent.id, []);
      expect(await listingChildren.getIds(parent.id)).toEqual([]);
    });
  });

  describe("listingParents", () => {
    test("reverse lookup returns the parent ids a child is offered under", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      expect(await listingParents.getIds(childA.id)).toEqual([parent.id]);
    });

    test("returns a child's parent ids ascending regardless of link order", async () => {
      const { parent, childA } = await threeListings();
      const parent2 = await createTestListing({ name: "Base unit 2" });
      // Link the higher-id parent first so insert order is descending.
      await linkChildToParents(childA.id, [parent2.id, parent.id]);
      expect(await listingParents.getIds(childA.id)).toEqual(
        ascending([parent.id, parent2.id]),
      );
    });

    test("hydrates the parent listings of a child", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      const parents =
        (await hydratedListings(listingParents, [childA.id])).get(childA.id) ??
        [];
      expect(parents.map((p) => p.id)).toEqual([parent.id]);
      expect(parents.map((p) => p.name)).toEqual(["Base unit"]);
    });

    test("returns an empty array when the child has no parents", async () => {
      const { childA } = await threeListings();
      expect(
        (await hydratedListings(listingParents, [childA.id])).get(childA.id) ??
          [],
      ).toEqual([]);
    });

    test("drops parent edges whose listing no longer exists", async () => {
      const { childA } = await threeListings();
      const missingParentId = childA.id + 100_000;
      await listingChildren.setIds(missingParentId, [childA.id]);
      // The edge row exists but no parent listing does, so hydration drops it.
      expect(await listingParents.getIds(childA.id)).toEqual([missingParentId]);
      expect(
        (await hydratedListings(listingParents, [childA.id])).get(childA.id) ??
          [],
      ).toEqual([]);
    });
  });

  describe("listingParents.getIdsByKeys", () => {
    test("returns the subset of ids that are children of some parent", async () => {
      const { parent, childA, childB } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      const result = await listingParents.getIdsByKeys([
        parent.id,
        childA.id,
        childB.id,
      ]);
      expect(result.get(parent.id)).toEqual([]);
      expect(result.get(childA.id)).toEqual([parent.id]);
      expect(result.get(childB.id)).toEqual([]);
    });

    test("returns an empty set for an empty input (no query)", async () => {
      expect(await listingParents.getIdsByKeys([])).toEqual(new Map());
    });

    test("finds a child from a single-id lookup", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      expect(await listingParents.getIdsByKeys([childA.id])).toEqual(
        new Map([[childA.id, [parent.id]]]),
      );
    });
  });

  test("listingIdsWithLinks keeps exactly the keys with linked ids", () => {
    expect(
      listingIdsWithLinks(
        new Map([
          [1, []],
          [2, [9]],
        ]),
      ),
    ).toEqual(new Set([2]));
  });

  describe("anyNonStandaloneChild", () => {
    test("is true with exactly one plain (non-standalone) child", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      expect(await anyNonStandaloneChild([childA.id])).toBe(true);
    });
  });

  describe("firstTouchingEdgeError", () => {
    test("walks child edges as parent, then parent edges as child", async () => {
      // The traversal contract: the saved listing is fixed on one side of each
      // edge, children first. Callers branch on `self`, so the labels and the
      // order are the behavior.
      const { parent, childA } = await threeListings();
      const middle = await createTestListing({ name: "Middle" });
      await listingChildren.setIds(middle.id, [childA.id]);
      await listingChildren.setIds(parent.id, [middle.id]);
      const seen: TouchingEdge[] = [];
      const error = await firstTouchingEdgeError(middle.id, (edge) => {
        seen.push(edge);
        return null;
      });
      expect(error).toBeNull();
      expect(seen).toEqual([
        { otherId: childA.id, self: "parent" },
        { otherId: parent.id, self: "child" },
      ]);
    });

    test("reads edge ids without loading listing rows", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      const queries = await runWithQueryLogContext(async () => {
        enableQueryLog();
        await firstTouchingEdgeError(parent.id, () => null);
        return getQueryLog().map((entry) => entry.sql);
      });
      expect(
        queries.some((sql) => /\b(?:from|join)\s+listings\b/i.test(sql)),
      ).toBe(false);
    });
  });

  describe("hydrateListingLinks", () => {
    test("keeps linked rows ordered but omits empty requested keys", async () => {
      const { parent, childA, childB } = await threeListings();
      const emptyParent = await createTestListing({ name: "Empty parent" });
      await listingChildren.setIds(parent.id, [childB.id, childA.id]);

      expect(
        await listingChildren.getIdsByKeys([emptyParent.id, parent.id]),
      ).toEqual(
        new Map([
          [emptyParent.id, []],
          [parent.id, ascending([childA.id, childB.id])],
        ]),
      );
      const hydrated = await hydratedListings(listingChildren, [
        emptyParent.id,
        parent.id,
      ]);
      expect([...hydrated.keys()]).toEqual([parent.id]);
      expect(hydrated.get(parent.id)?.map((listing) => listing.id)).toEqual(
        ascending([childA.id, childB.id]),
      );
    });

    test("omits a key when every linked listing is missing", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id + 100_000]);
      expect((await hydratedListings(listingChildren, [parent.id])).size).toBe(
        0,
      );
    });
  });

  describe("hydrated listingChildren", () => {
    test("groups hydrated children by parent, preserving child-id order", async () => {
      const { parent, childA, childB } = await threeListings();
      await listingChildren.setIds(parent.id, [childB.id, childA.id]);
      const map = await hydratedListings(listingChildren, [parent.id]);
      // Order is by child id ascending (the query's ORDER BY), not insert order.
      expect(map.get(parent.id)?.map((c) => c.id)).toEqual(
        ascending([childA.id, childB.id]),
      );
    });

    test("loads several parents in one call (no N+1)", async () => {
      const { parent, childA, childB } = await threeListings();
      const parent2 = await createTestListing({ name: "Base unit 2" });
      await listingChildren.setIds(parent.id, [childA.id]);
      await listingChildren.setIds(parent2.id, [childB.id]);
      const map = await hydratedListings(listingChildren, [
        parent2.id,
        parent.id,
      ]);
      expect([...map.keys()]).toEqual([parent.id, parent2.id]);
      expect(map.get(parent.id)?.map((c) => c.id)).toEqual([childA.id]);
      expect(map.get(parent2.id)?.map((c) => c.id)).toEqual([childB.id]);
    });

    test("omits parents with no children and returns empty for empty input", async () => {
      const { parent } = await threeListings();
      expect((await hydratedListings(listingChildren, [parent.id])).size).toBe(
        0,
      );
      expect((await hydratedListings(listingChildren, [])).size).toBe(0);
    });

    test("drops a child edge whose listing no longer exists", async () => {
      const { parent, childA } = await threeListings();
      const missingChildId = childA.id + 100_000;
      await listingChildren.setIds(parent.id, [childA.id, missingChildId]);
      const map = await hydratedListings(listingChildren, [parent.id]);
      expect(map.get(parent.id)?.map((c) => c.id)).toEqual([childA.id]);
    });
  });

  describe("hydrated listingParents", () => {
    test("groups hydrated parents by child, preserving parent-id order", async () => {
      const { parent, childA } = await threeListings();
      const parent2 = await createTestListing({ name: "Base unit 2" });
      await linkChildToParents(childA.id, [parent.id, parent2.id]);
      const map = await hydratedListings(listingParents, [childA.id]);
      expect(map.get(childA.id)?.map((p) => p.id)).toEqual(
        ascending([parent.id, parent2.id]),
      );
    });

    test("omits children with no parents and returns empty for empty input", async () => {
      const { childA } = await threeListings();
      expect((await hydratedListings(listingParents, [childA.id])).size).toBe(
        0,
      );
      expect((await hydratedListings(listingParents, [])).size).toBe(0);
    });

    test("drops a parent edge whose listing no longer exists", async () => {
      const { parent, childA } = await threeListings();
      const missingParentId = childA.id + 100_000;
      await linkChildToParents(childA.id, [parent.id, missingParentId]);
      const map = await hydratedListings(listingParents, [childA.id]);
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
      await listingChildren.setIds(parent.id, [childA.id]);
      expect(await edgeIncompatibilityAfterChange(edge(parent.id))).toBeNull();
    });

    test("flags a change that breaks the listing as a parent", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      const error = await edgeIncompatibilityAfterChange(
        edge(parent.id, { months_per_unit: 12 }),
      );
      expect(error).not.toBeNull();
    });

    test("flags a change that breaks the listing as a child", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      const error = await edgeIncompatibilityAfterChange(
        edge(childA.id, { months_per_unit: 12 }),
      );
      expect(error).not.toBeNull();
    });

    test("keeps a parent-side edit on the parent side of the edge", async () => {
      // A standard child under a daily parent is compatible ("a one-off fee or
      // merch add-on under a multi-day base"), but a daily child under a
      // standard parent is an error. Editing the PARENT to daily must stay
      // compatible; were its edge evaluated on the child side instead, the
      // standard child would read as the parent of a daily listing and a
      // phantom error would appear.
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      const error = await edgeIncompatibilityAfterChange(
        edge(parent.id, { listing_type: "daily", name: "Daily base" }),
      );
      expect(error).toBeNull();
    });

    test("validates the edited listing on its own side of the edge", async () => {
      // The two cases above break symmetrically (a renewal tier is rejected on
      // either side), so they pass even if the parent/child arguments are
      // swapped. This pins the *direction*: editing the child into a daily
      // listing is invalid only as "a daily child under a (standard) parent".
      // Were the arguments swapped, the standard parent would read as a
      // compatible standard child and the breakage would vanish.
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      const error = await edgeIncompatibilityAfterChange(
        edge(childA.id, { listing_type: "daily", name: "Daily add-on" }),
      );
      // Specifically the daily-direction error (naming the child and explaining
      // WHY): swapping the arguments would read the standard parent as a
      // compatible standard child and return null.
      expect(error).toBe(
        t("listings_table.children_err_child_daily", { name: "Daily add-on" }),
      );
    });

    test("ignores edges whose opposite endpoint no longer exists", async () => {
      const { childA } = await threeListings();
      const missing = childA.id + 100_000;
      // An edge pointing at a missing child, and one pointing at a missing parent.
      await listingChildren.setIds(childA.id, [missing]);
      await listingChildren.setIds(missing, [childA.id]);
      expect(await edgeIncompatibilityAfterChange(edge(childA.id))).toBeNull();
    });
  });

  describe("deleteListing cleanup", () => {
    test("removes edges where the deleted listing is the parent", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      await deleteListing(parent.id);
      expect(await listingParents.getIds(childA.id)).toEqual([]);
    });

    test("removes edges where the deleted listing is the child", async () => {
      const { parent, childA } = await threeListings();
      await listingChildren.setIds(parent.id, [childA.id]);
      await deleteListing(childA.id);
      expect(await listingChildren.getIds(parent.id)).toEqual([]);
    });
  });
});
