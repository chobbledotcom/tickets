import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { buildForest, buildNavModel } from "#shared/site-pages/core.ts";
import type { TargetMap } from "#shared/site-pages/types.ts";
import {
  PublicNav,
  type PublicNavProps,
  publicPage,
} from "#templates/public/shared.tsx";
import {
  navEdge as edge,
  navKey,
  navPage as page,
} from "#test/test-utils/site-pages/nav-fixtures.ts";

// ---------------------------------------------------------------------------
// Pure render tests for the recursive public nav: feed plain NavModel fixtures
// (via the real core) and assert the emitted structure. The route tests cover
// page-current models; this covers the leaf-current shape the core supports
// (the deepest level carrying the active leaf), which terminates the desktop
// recursion at the last level.
// ---------------------------------------------------------------------------

/** A tree: page 1 (root) contains page 2; page 2 contains listing 7. */
const props = (live: boolean): PublicNavProps => {
  const forest = buildForest(
    [page(1), page(2)],
    [edge(1, "page", 2), edge(2, "listing", 7)],
  );
  const targets: TargetMap = new Map([
    [
      navKey("listing", 7),
      { href: "/ticket/leaf", label: "Leaf Listing", live },
    ],
  ]);
  return {
    hasContact: false,
    hasNews: false,
    hasOrder: false,
    hasTerms: true,
    pages: buildNavModel(forest, targets, navKey("listing", 7)),
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

  test("stays a direct main child beside the public page layout", () => {
    const html = publicPage(
      "Example",
      "Website",
      props(true),
    )(Raw({ html: "<p>Page body</p>" }));

    expect(html).toContain('<h1>Website</h1><div class="admin-nav-group">');
    expect(html).toContain(
      '</nav></div><div class="page-regions public-page"><p>Page body</p></div>',
    );
  });
});
