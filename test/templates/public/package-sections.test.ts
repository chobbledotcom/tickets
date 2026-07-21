/**
 * Direct render tests for a booking page selling PACKAGE SECTIONS beside
 * standalone rows (the multi-item cart layout) — in-process, so the layout's
 * coverage never depends on the server-test harness.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#shared/booking/model.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import { pagePackage } from "#test/lib/package-cap-fixtures.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const ticketListing = (over: Partial<ListingWithCount>) =>
  buildTicketListing(
    testListingWithCount({ attendee_count: 0, max_attendees: 100, ...over }),
    false,
    undefined,
  );

const member = () => ticketListing({ id: 1, name: "Kit Tent", slug: "tent1" });
const solo = () =>
  ticketListing({ id: 2, max_quantity: 5, name: "Lantern", slug: "lant1" });

/** A cart page: package 7 (member listing 1) beside standalone listing 2. */
const mixedPage = (memberListing = member()) =>
  ticketPage({
    listings: [memberListing, solo()],
    packages: [pagePackage(7, [1], { name: "Party Bundle" })],
    slugs: ["pkg7s", "lant1"],
  });

describe("ticketPage — package sections beside standalone rows", () => {
  beforeAll(setupAdminPageTest);

  test("renders the bundle as a titled section and keeps the listing's own row", () => {
    const html = mixedPage();
    expect(html).toContain('data-package-section="7"');
    expect(html).toContain("Party Bundle");
    expect(html).toContain('name="package_quantity_7"');
    // The standalone listing keeps its own quantity selector; the member has
    // none of its own (it books through the bundle's count).
    expect(html).toContain('name="quantity_2"');
    expect(html).not.toContain('name="quantity_1"');
  });

  test("a sold-out bundle dims to a label while the rest of the page books", () => {
    const html = mixedPage(
      ticketListing({
        attendee_count: 100,
        id: 1,
        name: "Kit Tent",
        slug: "tent1",
      }),
    );
    // The section stays (sold-out stub), its selector goes, the solo row lives.
    expect(html).toContain('class="ticket-package sold-out"');
    expect(html).toContain("Sold Out");
    expect(html).not.toContain('name="package_quantity_7"');
    expect(html).toContain('name="quantity_2"');
    expect(html).not.toContain("Sorry, all listings are sold out.");
  });

  test("a member also added by its own slug gets a standalone row beside its section", () => {
    const html = ticketPage({
      listings: [member(), solo()],
      packages: [pagePackage(7, [1], { name: "Party Bundle" })],
      slugs: ["pkg7s", "tent1", "lant1"],
    });
    // Both paths at once: the bundle's count selector AND the member's own row.
    expect(html).toContain('name="package_quantity_7"');
    expect(html).toContain('name="quantity_1"');
  });

  test("a one-listing mixed page still NAMES the standalone row under the section", () => {
    // The page's only listing books through the bundle AND its own row. The
    // page is "single listing" for its header, but the standalone selector
    // sits below a package section — it must render as a named row, never the
    // bare single-listing controls (an unlabelled quantity box).
    const html = ticketPage({
      listings: [member()],
      packages: [pagePackage(7, [1], { name: "Party Bundle" })],
      slugs: ["pkg7s", "tent1"],
    });
    expect(html).toContain('name="package_quantity_7"');
    // The standalone row carries the listing's name label (the row renderer's
    // ticket-row), beside — not merged into — the bundle's member row.
    expect(html).toContain('name="quantity_1"');
    expect(html).toContain('<div class="ticket-row">');
  });

  test("a single-package page keeps the classic layout (no section fieldset)", () => {
    const html = ticketPage({
      listings: [member()],
      packages: [pagePackage(7, [1], { name: "Party Bundle" })],
      slugs: ["pkg7s"],
    });
    expect(html).toContain('name="package_quantity_7"');
    expect(html).not.toContain("data-package-section");
  });
});
