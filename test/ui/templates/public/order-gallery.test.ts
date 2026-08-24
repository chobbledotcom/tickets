import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type OrderGalleryStates,
  orderGalleryPage,
} from "#templates/public/order-gallery.tsx";
import type { PublicNavProps } from "#templates/public/shared.tsx";
import { getRealEnv, withEnv } from "#test-utils/env.ts";
import { testGroup } from "#test-utils/factories.ts";

/** A nav with no operator pages and every optional link off. */
const emptyNav: PublicNavProps = {
  hasContact: false,
  hasNews: false,
  hasOrder: true,
  hasTerms: false,
  pages: {
    activeRootId: null,
    currentChildren: [],
    rootPageNodes: [],
    submenuLevels: [],
  },
};

/** Live-availability states with nothing date-bound and no labels. */
const states: OrderGalleryStates = { anyNeedsDate: false, labelFor: () => "" };

describe("orderGalleryPage packages", () => {
  test("renders package groups as selectable cart cards, sorted by name", () => {
    // No individual listings — only packages — so the grid holds just the
    // package cards, selectable in the shared order form like listings.
    const html = orderGalleryPage(
      [],
      [
        {
          group: testGroup({
            id: 1,
            is_package: true,
            name: "Zeta Bundle",
            slug: "zeta",
          }),
          members: [],
        },
        {
          group: testGroup({
            id: 2,
            is_package: true,
            name: "Alpha Bundle",
            slug: "alpha",
          }),
          members: [],
        },
      ],
      states,
      emptyNav,
      "",
    );
    expect(html).toContain("Packages");
    // A package joins the cart as a checkbox card, never a direct book link.
    expect(html).toContain('name="select_package_1"');
    expect(html).toContain('name="select_package_2"');
    expect(html).toContain('data-order-key="package:1"');
    expect(html).toContain('class="order-select"');
    expect(html).toContain('class="order-gallery"');
    // Order cards build on the shared Card markup (also used by /news).
    expect(html).toContain('class="card order-card"');
    expect(html).toContain('class="card-body"');
    expect(html).toContain('class="card-name"');
    expect(html).toContain('class="card-grid order-grid"');
    expect(html).not.toContain('href="/ticket/alpha"');
    expect(html).not.toContain('href="/ticket/zeta"');
    // Sorted by decrypted name: Alpha precedes Zeta.
    expect(html.indexOf("Alpha Bundle")).toBeLessThan(
      html.indexOf("Zeta Bundle"),
    );
  });

  test("renders packages as unavailable, not selectable, in read-only mode", () => {
    using _env = withEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
    const html = orderGalleryPage(
      [],
      [
        {
          group: testGroup({
            is_package: true,
            name: "Frozen Bundle",
            slug: "frozen",
          }),
          members: [],
        },
      ],
      states,
      emptyNav,
      "",
    );
    expect(html).toContain("Frozen Bundle");
    expect(html).toContain('class="card order-card order-card--unavailable"');
    expect(html).toContain("Registration Closed");
    // No live booking affordance while the site is read-only: neither a
    // link nor a selectable checkbox.
    expect(html).not.toContain('href="/ticket/frozen"');
    expect(html).not.toContain('class="order-select"');
    // The cutoff must stay in this worker's env overlay: a write to the real
    // process env is visible to every parallel test worker and flips the
    // whole app read-only under them mid-test.
    expect(getRealEnv("READ_ONLY_FROM")).toBeUndefined();
  });
});
