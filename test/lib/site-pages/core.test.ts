import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ancestorsOf,
  buildForest,
  buildNavModel,
  descendantsOf,
  eligibleChildPages,
  isReservedSlug,
  parseTargetKey,
  planReorder,
  targetKey,
  wouldCreateCycle,
} from "#shared/site-pages/core.ts";
import type { TargetKey, TargetMap } from "#shared/site-pages/types.ts";
import type {
  SitePageItem,
  SitePageItemType,
  SitePageNavRow,
} from "#shared/types.ts";

const page = (id: number, sort_order = id): SitePageNavRow => ({
  id,
  name: `page-${id}`,
  slug: `page-${id}`,
  sort_order,
});

const edge = (
  page_id: number,
  item_type: SitePageItemType,
  item_id: number,
  sort_order: number,
): SitePageItem => ({ item_id, item_type, page_id, sort_order });

/** A linear chain 1 (root) → 2 → 3, reused across ancestry/cycle tests. */
const chainForest = () =>
  buildForest(
    [page(1), page(2), page(3)],
    [edge(1, "page", 2, 0), edge(2, "page", 3, 0)],
  );

const leafTarget = (
  type: SitePageItemType,
  id: number,
  live = true,
): [TargetKey, { href: string; label: string; live: boolean }] => [
  targetKey(type, id),
  { href: `/ticket/${type}-${id}`, label: `${type}-${id}`, live },
];

describe("site-pages core", () => {
  describe("targetKey / parseTargetKey", () => {
    test("round-trips every item type", () => {
      for (const type of ["listing", "group", "page"] as const) {
        const parsed = parseTargetKey(targetKey(type, 42));
        expect(parsed).toEqual({ id: 42, type });
      }
    });
  });

  describe("buildForest", () => {
    test("is order-independent: roots sorted by (sort_order, id)", () => {
      const pages = [page(3, 5), page(1, 5), page(2, 1)];
      const forest = buildForest(pages, []);
      // sort_order asc then id asc: page2(1), then page1(5,id1), page3(5,id3)
      expect(forest.rootIds).toEqual([2, 1, 3]);
    });

    test("a page named as a child edge is not a root", () => {
      const forest = buildForest([page(1), page(2)], [edge(1, "page", 2, 0)]);
      expect(forest.rootIds).toEqual([1]);
      expect(forest.parentByChild.get(2)).toBe(1);
    });

    test("a non-page item never parents a page that shares its numeric id", () => {
      // listing item with item_id 2 must NOT make page 2 a child of page 1.
      const forest = buildForest(
        [page(1), page(2)],
        [edge(1, "listing", 2, 0)],
      );
      expect(forest.rootIds).toEqual([1, 2]);
      expect(forest.parentByChild.has(2)).toBe(false);
    });

    test("items are grouped per page and sorted by (sort_order, item_id)", () => {
      const forest = buildForest(
        [page(1)],
        [
          edge(1, "listing", 9, 1),
          edge(1, "group", 4, 0),
          edge(1, "listing", 2, 0),
        ],
      );
      const items = forest.itemsByPage.get(1) ?? [];
      // order 0 rows first (tiebreak item_id: 2 < 4), then order 1.
      expect(items.map((i) => `${i.item_type}:${i.item_id}`)).toEqual([
        "listing:2",
        "group:4",
        "listing:9",
      ]);
    });
  });

  describe("ancestorsOf", () => {
    test("returns the chain root-first, excluding the node", () => {
      const forest = chainForest(); // 1 (root) → 2 → 3
      expect(ancestorsOf(forest, 3)).toEqual([1, 2]);
      expect(ancestorsOf(forest, 1)).toEqual([]);
    });

    test("throws on a cyclic edge set rather than looping", () => {
      const forest = buildForest(
        [page(1), page(2)],
        [edge(1, "page", 2, 0), edge(2, "page", 1, 0)],
      );
      expect(() => ancestorsOf(forest, 1)).toThrow(/cycle/);
    });

    test("throws on a cycle among ancestors that excludes the queried node", () => {
      // parents: 1→2, 2→3, 3→2 (the 2↔3 loop sits above the queried node 1),
      // so only the visited-set bookkeeping (not the initial node) catches it.
      const forest = buildForest(
        [page(1), page(2), page(3)],
        [edge(2, "page", 1, 0), edge(2, "page", 3, 1), edge(3, "page", 2, 0)],
      );
      expect(() => ancestorsOf(forest, 1)).toThrow(/cycle/);
    });
  });

  describe("descendantsOf", () => {
    test("collects transitive child pages, skipping non-page items and revisits", () => {
      // 1 → {page 2, listing 99, page 3}; 2 → page 3 (already reached via 1).
      const forest = buildForest(
        [page(1), page(2), page(3)],
        [
          edge(1, "page", 2, 0),
          edge(1, "listing", 99, 1), // non-page item → skipped
          edge(1, "page", 3, 2), // reached directly
          edge(2, "page", 3, 0), // revisit of 3 → the out.has guard fires
        ],
      );
      expect([...descendantsOf(forest, 1)].sort((a, b) => a - b)).toEqual([
        2, 3,
      ]);
      expect([...descendantsOf(forest, 3)]).toEqual([]);
    });

    test("collects descendants reachable only transitively (recurses)", () => {
      // 1 → 2 → 3, with 3 NOT a direct child of 1 — only recursion reaches it.
      const forest = buildForest(
        [page(1), page(2), page(3)],
        [edge(1, "page", 2, 0), edge(2, "page", 3, 0)],
      );
      expect([...descendantsOf(forest, 1)].sort((a, b) => a - b)).toEqual([
        2, 3,
      ]);
    });
  });

  describe("wouldCreateCycle", () => {
    const forest = chainForest();
    test("true for self and any ancestor of the parent", () => {
      expect(wouldCreateCycle(forest, 3, 3)).toBe(true); // self
      expect(wouldCreateCycle(forest, 3, 1)).toBe(true); // ancestor
      expect(wouldCreateCycle(forest, 3, 2)).toBe(true); // ancestor
    });
    test("false for an unrelated or descendant candidate", () => {
      // Adding 1 under 3 loops (1 is ancestor) — but 3 under 1 does not.
      expect(wouldCreateCycle(forest, 1, 3)).toBe(false);
    });
  });

  describe("eligibleChildPages", () => {
    test("excludes self, already-parented pages, and ancestors", () => {
      // 1(root)→2 ; 3 root, 4 root (unparented)
      const forest = buildForest(
        [page(1), page(2), page(3), page(4)],
        [edge(1, "page", 2, 0)],
      );
      // Candidates to add under 2: exclude 2 (self), 1 (ancestor), 2-already? ;
      // 3 and 4 are unparented and no cycle → eligible.
      expect(eligibleChildPages(forest, 2).map((p) => p.id)).toEqual([3, 4]);
    });
  });

  describe("planReorder", () => {
    const keys: TargetKey[] = ["page:1", "listing:2", "group:3"];
    test("swaps with the correct neighbour", () => {
      expect(planReorder(keys, "listing:2", "up")).toEqual([
        "listing:2",
        "page:1",
      ]);
      expect(planReorder(keys, "listing:2", "down")).toEqual([
        "listing:2",
        "group:3",
      ]);
    });
    test("null at boundaries and for a missing key", () => {
      expect(planReorder(keys, "page:1", "up")).toBeNull();
      expect(planReorder(keys, "group:3", "down")).toBeNull();
      expect(planReorder(keys, "listing:99", "up")).toBeNull();
    });
  });

  describe("isReservedSlug", () => {
    test("rejects reserved words (case/space-insensitive), allows others", () => {
      expect(isReservedSlug("contact")).toBe(true);
      expect(isReservedSlug(" Listings ")).toBe(true);
      expect(isReservedSlug("about-us")).toBe(false);
    });
  });

  describe("buildNavModel", () => {
    test("root nodes are the roots in order; off-tree ⇒ no submenus", () => {
      const forest = buildForest([page(2, 1), page(1, 0)], []);
      const model = buildNavModel(forest, new Map(), null);
      expect(model.rootPageNodes.map((n) => n.key)).toEqual([
        "page:1",
        "page:2",
      ]);
      expect(model.rootPageNodes.every((n) => !n.active)).toBe(true);
      expect(model.submenuLevels).toEqual([]);
      expect(model.activeRootId).toBeNull();
    });

    test("a leaf item resolves from the TargetMap; unresolved leaves drop out", () => {
      const forest = buildForest(
        [page(1)],
        [edge(1, "listing", 10, 0), edge(1, "group", 20, 1)],
      );
      const targets: TargetMap = new Map([leafTarget("listing", 10)]); // no group:20
      const model = buildNavModel(forest, targets, "page:1");
      const level = model.submenuLevels[0] ?? [];
      expect(level.map((n) => n.key)).toEqual(["listing:10"]); // group dropped
      expect(level[0]?.href).toBe("/ticket/listing-10");
    });

    test("highlights only the chosen-path occurrence of a multi-parent leaf", () => {
      // R(id1,sort5) contains page P(id2) and listing 10; P contains listing 10.
      // current = listing:10 → N6 anchor is P (sort 0 < R's 5).
      const forest = buildForest(
        [page(1, 5), page(2, 0)],
        [
          edge(1, "page", 2, 0),
          edge(1, "listing", 10, 1),
          edge(2, "listing", 10, 0),
        ],
      );
      const targets: TargetMap = new Map([leafTarget("listing", 10)]);
      const model = buildNavModel(forest, targets, "listing:10");

      expect(model.activeRootId).toBe(1);
      expect(model.submenuLevels).toHaveLength(2);

      const level0 = model.submenuLevels[0] ?? [];
      const pNode = level0.find((n) => n.key === "page:2");
      const leafUnderR = level0.find((n) => n.key === "listing:10");
      expect(pNode?.active).toBe(true); // chain continues through P
      expect(leafUnderR?.active).toBe(false); // NOT the chosen occurrence

      const level1 = model.submenuLevels[1] ?? [];
      const leafUnderP = level1.find((n) => n.key === "listing:10");
      expect(leafUnderP?.active).toBe(true); // the chosen occurrence
    });

    test("multi-parent leaf tie-breaks by edge sort_order, then page id (N6)", () => {
      // listing 7 under page A (root order 0, edge order 10) and page B (root
      // order 5, edge order 0). Root order favours A, but the lower EDGE order
      // (B's 0 < A's 10) wins — proving the tie-break is by edge, not page order.
      const forest = buildForest(
        [page(1, 0), page(2, 5)],
        [edge(1, "listing", 7, 10), edge(2, "listing", 7, 0)],
      );
      const model = buildNavModel(
        forest,
        new Map([leafTarget("listing", 7)]),
        "listing:7",
      );
      expect(model.activeRootId).toBe(2);
    });

    test("equal edge orders tie-break by page id (lower wins)", () => {
      const forest = buildForest(
        [page(1, 9), page(2, 0)],
        [edge(2, "listing", 7, 0), edge(1, "listing", 7, 0)], // same edge order
      );
      const model = buildNavModel(
        forest,
        new Map([leafTarget("listing", 7)]),
        "listing:7",
      );
      expect(model.activeRootId).toBe(1); // lower page id breaks the tie
    });

    test("a leaf under a nonexistent page id is off-tree", () => {
      // An edge whose page_id has no page row (defensive) is skipped.
      const forest = buildForest([page(1)], [edge(2, "listing", 5, 0)]);
      const model = buildNavModel(forest, new Map(), "listing:5");
      expect(model.activeRootId).toBeNull();
    });

    test("visiting a root page shows its own children (N7), none active", () => {
      const forest = buildForest([page(1), page(2)], [edge(1, "page", 2, 0)]);
      const model = buildNavModel(forest, new Map(), "page:1");
      expect(model.activeRootId).toBe(1);
      expect(model.rootPageNodes.find((n) => n.key === "page:1")?.active).toBe(
        true,
      );
      // One level (page 1's own items): the child page 2, not active.
      expect(model.submenuLevels).toHaveLength(1);
      expect(model.submenuLevels[0]?.[0]?.key).toBe("page:2");
      expect(model.submenuLevels[0]?.[0]?.active).toBe(false);
      // Page nodes are always live (both the root row and the nested node).
      expect(model.rootPageNodes[0]?.live).toBe(true);
      expect(model.submenuLevels[0]?.[0]?.live).toBe(true);
    });

    test("a page item pointing at a missing page is dropped", () => {
      const forest = buildForest([page(1)], [edge(1, "page", 99, 0)]);
      const model = buildNavModel(forest, new Map(), "page:1");
      expect(model.submenuLevels[0]).toEqual([]);
    });

    test("a childless root page as current yields one empty submenu level", () => {
      const forest = buildForest([page(1)], []);
      const model = buildNavModel(forest, new Map(), "page:1");
      expect(model.activeRootId).toBe(1);
      expect(model.submenuLevels).toEqual([[]]);
    });

    test("a current page id that doesn't exist is off-tree", () => {
      const forest = buildForest([page(1)], []);
      const model = buildNavModel(forest, new Map(), "page:999");
      expect(model.activeRootId).toBeNull();
      expect(model.submenuLevels).toEqual([]);
    });

    test("a leaf's parent scan matches on type AND id, not either alone", () => {
      // page 1 holds group:5; the current target is listing:5 (same id, other
      // type) — so no page is its parent and there's no contextual chain.
      const forest = buildForest([page(1)], [edge(1, "group", 5, 0)]);
      const model = buildNavModel(forest, new Map(), "listing:5");
      expect(model.activeRootId).toBeNull();
      expect(model.submenuLevels).toEqual([]);
    });

    test("a root page with id 0 is a valid active root (not coerced to null)", () => {
      const forest = buildForest([page(0)], []);
      const model = buildNavModel(forest, new Map(), "page:0");
      expect(model.activeRootId).toBe(0);
    });

    test("a leaf whose parent page has id 0 anchors to it (not null)", () => {
      const forest = buildForest([page(0)], [edge(0, "listing", 5, 0)]);
      const model = buildNavModel(
        forest,
        new Map([leafTarget("listing", 5)]),
        "listing:5",
      );
      expect(model.activeRootId).toBe(0);
    });

    test("a leaf with no parent page yields a flat nav (no chain)", () => {
      const forest = buildForest([page(1)], []);
      const model = buildNavModel(
        forest,
        new Map([leafTarget("listing", 7)]),
        "listing:7",
      );
      expect(model.activeRootId).toBeNull();
      expect(model.submenuLevels).toEqual([]);
    });
  });
});
