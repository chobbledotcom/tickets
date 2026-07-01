import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildForest,
  buildNavModel,
  targetKey,
} from "#shared/site-pages/core.ts";
import type { TargetMap } from "#shared/site-pages/types.ts";
import type { SitePageItem, SitePageNavRow } from "#shared/types.ts";
import { PublicNav, type PublicNavProps } from "#templates/public/shared.tsx";

// ---------------------------------------------------------------------------
// Pure render tests for the recursive public nav: feed plain NavModel fixtures
// (via the real core) and assert the emitted structure. The route tests cover
// page-current models; this covers the leaf-current shape the core supports
// (the deepest level carrying the active leaf), which terminates the desktop
// recursion at the last level.
// ---------------------------------------------------------------------------

const page = (id: number, sortOrder = 0): SitePageNavRow => ({
  id,
  name: `Page ${id}`,
  slug: `page-${id}`,
  sort_order: sortOrder,
});

const edge = (
  pageId: number,
  type: SitePageItem["item_type"],
  itemId: number,
  sortOrder = 0,
): SitePageItem => ({
  item_id: itemId,
  item_type: type,
  page_id: pageId,
  sort_order: sortOrder,
});

/** A tree: page 1 (root) contains page 2; page 2 contains listing 7. */
const props = (live: boolean): PublicNavProps => {
  const forest = buildForest(
    [page(1), page(2)],
    [edge(1, "page", 2), edge(2, "listing", 7)],
  );
  const targets: TargetMap = new Map([
    [
      targetKey("listing", 7),
      { href: "/ticket/leaf", label: "Leaf Listing", live },
    ],
  ]);
  return {
    hasContact: false,
    hasOrder: false,
    hasTerms: true,
    pages: buildNavModel(forest, targets, targetKey("listing", 7)),
  };
};

describe("PublicNav (leaf-current render)", () => {
  test("marks the leaf active and terminates the nesting at its level", () => {
    const html = String(PublicNav(props(true)));
    // The whole chain renders: root subnav → page 2 → the active leaf link.
    expect(html).toContain('<a class="active" href="/ticket/leaf">');
    // Nesting stops at the leaf level: exactly two desktop subnav levels
    // (page 1's children, page 2's children), each once more in mobile bars.
    expect((html.match(/admin-subnav/g) ?? []).length).toBe(2);
    // Mobile bars are named for each level's parent page.
    expect(html).toContain('aria-label="Page 1"');
    expect(html).toContain('aria-label="Page 2"');
    // The terms link renders in both the desktop and mobile root rows.
    expect((html.match(/href="\/terms"/g) ?? []).length).toBe(2);
  });

  test("a dead leaf renders as text even while active", () => {
    const html = String(PublicNav(props(false)));
    expect(html).toContain("<span>Leaf Listing</span>");
    expect(html).not.toContain('href="/ticket/leaf"');
  });
});
