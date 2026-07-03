import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { orderGalleryPage } from "#templates/public/order-gallery.tsx";
import type { PublicNavProps } from "#templates/public/shared.tsx";
import { getRealEnv, setTestEnv, testGroup } from "#test-utils";

/** A nav with no operator pages and every optional link off. */
const emptyNav: PublicNavProps = {
  hasContact: false,
  hasOrder: true,
  hasTerms: false,
  pages: {
    activeRootId: null,
    currentChildren: [],
    rootPageNodes: [],
    submenuLevels: [],
  },
};

describe("orderGalleryPage packages", () => {
  test("renders package groups as direct book links, sorted by name", () => {
    // No individual listings — only packages — so the page is not the empty
    // state and renders no selection form, just the package link cards.
    const html = orderGalleryPage(
      [],
      [
        testGroup({
          id: 1,
          is_package: true,
          name: "Zeta Bundle",
          slug: "zeta",
        }),
        testGroup({
          id: 2,
          is_package: true,
          name: "Alpha Bundle",
          slug: "alpha",
        }),
      ],
      emptyNav,
    );
    expect(html).toContain("Packages");
    expect(html).toContain('class="order-card order-card--package"');
    expect(html).toContain('href="/ticket/alpha"');
    expect(html).toContain('href="/ticket/zeta"');
    // Sorted by decrypted name: Alpha precedes Zeta.
    expect(html.indexOf("Alpha Bundle")).toBeLessThan(
      html.indexOf("Zeta Bundle"),
    );
    // A package is a link, never a selectable cart checkbox or its form.
    expect(html).not.toContain("order-select");
    expect(html).not.toContain('class="order-gallery"');
  });

  test("renders packages as unavailable, not book links, in read-only mode", () => {
    const restore = setTestEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
    try {
      const html = orderGalleryPage(
        [],
        [
          testGroup({
            is_package: true,
            name: "Frozen Bundle",
            slug: "frozen",
          }),
        ],
        emptyNav,
      );
      expect(html).toContain("Frozen Bundle");
      expect(html).toContain("order-card--unavailable");
      expect(html).toContain("Registration Closed");
      // No live booking link while the site is read-only.
      expect(html).not.toContain('href="/ticket/frozen"');
      // The cutoff must stay in this worker's env overlay: a write to the real
      // process env is visible to every parallel test worker and flips the
      // whole app read-only under them mid-test.
      expect(getRealEnv("READ_ONLY_FROM")).toBeUndefined();
    } finally {
      restore();
    }
  });
});
