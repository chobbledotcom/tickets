import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AttributeWithOptions } from "#shared/db/attributes.ts";
import { FormParams } from "#shared/form-data.ts";
import { clearSavedFormData, setSavedFormData } from "#shared/forms.tsx";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import {
  bigAndSmallListings,
  evenSplitPackages,
  listingB,
  PKG_SLUG,
  pagePackage,
  registerPublicTemplateHooks,
  ticketListing,
} from "./helpers.ts";

registerPublicTemplateHooks();

const attributeWithOptions = (
  id: number,
  name: string,
  optionText: string,
): AttributeWithOptions => ({
  id,
  name,
  options: [{ attribute_id: id, id: id * 10, sort_order: 0, text: optionText }],
  sort_order: 0,
});

describe("ticketPage — packages", () => {
  test("shows all sold out message when every listing is sold out", () => {
    const listings = [
      ticketListing({
        attendee_count: 100,
        id: 1,
        max_attendees: 100,
        name: "Listing A",
        slug: "ab12c",
      }),
      listingB(),
    ];
    const html = ticketPage({ listings, slugs: ["ab12c", "cd34e"] });
    expect(html).toContain("Sorry, all listings are sold out.");
    expect(html).not.toContain("Reserve Tickets</button>");
  });

  test("renders a package quantity selector and member rows with fixed quantities", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        max_attendees: 100,
        name: "Tent",
        slug: "tent1",
      }),
      ticketListing({
        attendee_count: 0,
        id: 2,
        max_attendees: 100,
        // ×4 per package, so its per-order limit must admit at least 4.
        max_quantity: 10,
        name: "Chair",
        slug: "chr12",
      }),
    ];
    const html = ticketPage({
      groupName: "Camp Kit",
      listings,
      // Only listing 2 has a quantity row; listing 1 falls back to ×1.
      packages: [pagePackage(5, [1, 2], { quantities: new Map([[2, 4]]) })],
      slugs: [PKG_SLUG],
    });
    expect(html).toContain('name="package_quantity_5"');
    expect(html).toContain("Number of packages");
    expect(html).toContain("Tent");
    expect(html).toContain("&times;1");
    expect(html).toContain("Chair");
    expect(html).toContain("&times;4");
    // No per-member quantity selectors on a package page.
    expect(html).not.toContain('name="quantity_1"');
  });

  test("restores the submitted package quantity after a validation error", () => {
    setSavedFormData(new FormParams({ package_quantity_5: "3" }));
    try {
      const listings = [
        ticketListing({
          attendee_count: 0,
          id: 1,
          max_attendees: 100,
          max_quantity: 10,
          name: "Tent",
          slug: "tent1",
        }),
      ];
      const html = ticketPage({
        groupName: "Camp Kit",
        listings,
        packages: [pagePackage(5, [1], { quantities: new Map([[1, 1]]) })],
        slugs: [PKG_SLUG],
      });
      // The selector pre-selects the just-submitted count, not a reset 1.
      expect(html).toContain('value="3" selected');
    } finally {
      clearSavedFormData();
    }
  });

  test("caps the package selector by the shared pool, defaulting a missing member quantity to 1", () => {
    const listings = bigAndSmallListings();
    const html = ticketPage({
      groupName: "Pool Pkg",
      listings,
      // Both members sit in the capped package group 7 (pool of 4). Member 1 is
      // also in group 8, which is uncapped (absent from the remaining map) and so
      // contributes no constraint.
      packageGroupRemainingByGroupId: new Map([[7, 4]]),
      packageMemberGroupIds: new Map([
        [1, [7, 8]],
        [2, [7]],
      ]),
      // Listing 1 takes 2 per package; listing 2 is omitted → defaults to 1, so
      // one package consumes 3 of the pool of 4 → floor(4 / 3) = 1 package fits.
      packages: [pagePackage(7, [1, 2], { quantities: new Map([[1, 2]]) })],
      slugs: [PKG_SLUG],
    });
    expect(html).toContain('name="package_quantity_7"');
    expect(html).toContain('<option value="1"');
    // The shared pool caps the count at 1, so no "2 packages" option is offered.
    expect(html).not.toContain('<option value="2"');
  });

  test("renders a package as sold out when its cap is zero", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        max_attendees: 100,
        name: "Big",
        slug: "big01",
      }),
      ticketListing({
        attendee_count: 0,
        id: 2,
        max_attendees: 100,
        name: "Small",
        slug: "sml01",
      }),
    ];
    // Both members still have individual capacity, but one package consumes 2
    // units (1 each) from a shared pool with only 1 left → floor(1 / 2) = 0
    // packages fit. The page must show sold out, not a 0-only selector.
    const html = ticketPage({
      groupName: "Drained Pkg",
      listings,
      packageGroupRemainingByGroupId: new Map([[7, 1]]),
      packageMemberGroupIds: new Map([
        [1, [7]],
        [2, [7]],
      ]),
      packages: evenSplitPackages(),
      slugs: [PKG_SLUG],
    });
    // No count selector for any package on the page.
    expect(html).not.toContain('name="package_quantity');
    expect(html).toContain("Sorry, all listings are sold out.");
  });

  test("caps the package by a SECOND capped group the members share", () => {
    const listings = bigAndSmallListings();
    // The package group (7) is roomy — floor(10 / 2) = 5 packages fit — but both
    // members ALSO belong to a second capped group (9) with only 2 spots, and one
    // package consumes 2 (1 each) from it → floor(2 / 2) = 1. The tighter shared
    // pool must bind, so only "1" is offered, never "2".
    const html = ticketPage({
      groupName: "Shared Pool Pkg",
      listings,
      packageGroupRemainingByGroupId: new Map([
        [7, 10],
        [9, 2],
      ]),
      packageMemberGroupIds: new Map([
        [1, [7, 9]],
        [2, [7, 9]],
      ]),
      packages: evenSplitPackages(),
      slugs: [PKG_SLUG],
    });
    expect(html).toContain('name="package_quantity_7"');
    expect(html).toContain('<option value="1"');
    expect(html).not.toContain('<option value="2"');
  });

  test("hides member rows when the package hides its listings", () => {
    const listings = [
      ticketListing({
        attendee_count: 0,
        id: 1,
        max_attendees: 100,
        name: "SecretItem",
        slug: "sec12",
      }),
    ];
    // quantities left empty exercises the defensive ×1 fallback.
    const html = ticketPage({
      groupName: "Hidden Bundle",
      listings,
      packages: [pagePackage(5, [1], { hideListings: true })],
      slugs: [PKG_SLUG],
    });
    expect(html).toContain('name="package_quantity_5"');
    expect(html).toContain("Hidden Bundle");
    expect(html).not.toContain("SecretItem");
  });

  test("renders attributes on package member rows", () => {
    const listings = bigAndSmallListings();
    const html = ticketPage({
      attributesByListing: new Map([
        [1, [attributeWithOptions(3, "Format", "Outdoor")]],
      ]),
      groupName: "Camp Kit",
      listings,
      packages: [pagePackage(5, [1, 2], { quantities: new Map([[2, 1]]) })],
      slugs: [PKG_SLUG],
    });
    expect(html).toContain("Format");
    expect(html).toContain("Outdoor");
  });

  test("renders attributes on package sections alongside standalone rows", () => {
    const listings = bigAndSmallListings();
    const html = ticketPage({
      attributesByListing: new Map([
        [1, [attributeWithOptions(3, "Level", "Beginner")]],
        [2, [attributeWithOptions(4, "Level", "Advanced")]],
      ]),
      listings,
      packages: [pagePackage(5, [1, 2])],
      slugs: [PKG_SLUG, "big01", "sml01"],
    });
    expect(html).toContain("Beginner");
    expect(html).toContain("Advanced");
  });
});
