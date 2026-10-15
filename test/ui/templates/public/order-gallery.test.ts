import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type OrderGalleryStates,
  orderGalleryPage,
} from "#templates/public/order-gallery.tsx";
import type { PublicNavProps } from "#templates/public/shared.tsx";
import { getRealEnv, withEnv } from "#test-utils/env.ts";
import { testGroup } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

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
    says(html, "Packages");
    // A package joins the cart as a checkbox card, never a direct book link.
    says(html, 'name="select_package_1"');
    says(html, 'name="select_package_2"');
    says(html, 'data-order-key="package:1"');
    says(html, 'class="order-select"');
    says(html, 'class="order-gallery"');
    // Order cards build on the shared Card markup (also used by /news).
    says(html, 'class="card order-card"');
    says(html, 'class="card-body"');
    says(html, 'class="card-name"');
    says(html, 'class="card-grid order-grid"');
    assert(!html.includes('href="/ticket/alpha"'));
    assert(!html.includes('href="/ticket/zeta"'));
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
    says(html, "Frozen Bundle");
    says(html, 'class="card order-card order-card--unavailable"');
    says(html, "Registration Closed");
    // No live booking affordance while the site is read-only: neither a
    // link nor a selectable checkbox.
    assert(!html.includes('href="/ticket/frozen"'));
    assert(!html.includes('class="order-select"'));
    // The cutoff must stay in this worker's env overlay: a write to the real
    // process env is visible to every parallel test worker and flips the
    // whole app read-only under them mid-test.
    expect(getRealEnv("READ_ONLY_FROM")).toBeUndefined();
  });
});
