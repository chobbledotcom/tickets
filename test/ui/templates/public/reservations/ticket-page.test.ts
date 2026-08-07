import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttributeWithOptions } from "#shared/db/attributes.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  clearSavedFormData,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import type { PublicNavProps } from "#templates/public/shared.tsx";
import {
  bigAndSmallListings,
  evenSplitPackages,
  listingB,
  PKG_SLUG,
  pagePackage,
  registerPublicTemplateHooks,
  ticketListing,
} from "#test/ui/templates/helpers.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { hasInputWithValue } from "#test-utils/csrf.ts";

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

/** A minimal public-nav prop set — the fixed root links only, no page tree. */
const navProps = (): PublicNavProps => ({
  hasContact: false,
  hasNews: false,
  hasOrder: false,
  hasTerms: false,
  pages: {
    activeRootId: null,
    currentChildren: [],
    rootPageNodes: [],
    submenuLevels: [],
  },
});

describe("ticketPage — packages", () => {
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  test("uses group header details before the single listing details", () => {
    const html = ticketPage({
      attributesByListing: new Map([
        [1, [attributeWithOptions(3, "Format", "Outdoor")]],
      ]),
      baseUrl: "https://tickets.example",
      groupDescription: "Group description",
      groupImage: {
        image_alt_text: "Group image",
        image_thumb_url: "group-thumb.webp",
        image_url: "group.webp",
      },
      groupName: "Group heading",
      listings: [
        ticketListing({
          description: "Listing description",
          id: 1,
          image_url: "listing.webp",
          name: "Listing heading",
          slug: "listing",
        }),
      ],
      slugs: ["group-page"],
    });
    expect(html).toContain("<title>Group heading</title>");
    expect(html).toContain("<h1>Group heading</h1>");
    expect(html).toContain("<p>Group description</p>");
    expect(html).not.toContain("Listing description");
    expect(html).toContain("/image/group.webp");
    expect(html).not.toContain("/image/listing.webp");
    expect(html).toContain("Format");
    expect(html).toContain("Outdoor");
    expect(html).toContain(
      'property="og:url" content="https://tickets.example/ticket/group-page"',
    );
  });

  test("keeps an intentionally empty group description", () => {
    const html = ticketPage({
      groupDescription: "",
      groupName: "Group heading",
      listings: [
        ticketListing({ description: "Listing description", name: "Listing" }),
      ],
      slugs: ["group-page"],
    });
    expect(html).not.toContain("Listing description");
  });

  test("keeps an intentionally empty group name", () => {
    const html = ticketPage({
      groupName: "",
      listings: [ticketListing({ name: "Listing heading" })],
      slugs: ["group-page"],
    });
    expect(html).toContain("<title>Reserve Tickets</title>");
    expect(html).not.toContain("<h1>Listing heading</h1>");
  });

  test("hides the header and marks the layout in iframe mode", () => {
    detectIframeMode(new URL("https://example.com/?iframe=true"));
    const html = ticketPage({
      groupName: "Iframe-only heading",
      listings: [ticketListing({ name: "Listing" })],
      slugs: ["group-page"],
    });
    expect(html).toContain('<body class="iframe">');
    expect(html).toContain('class="page-regions public-page"');
    expect(html).not.toContain("<h1>Iframe-only heading</h1>");
  });

  test("shows the site menu above the form on a normal page", () => {
    const html = ticketPage({
      listings: [ticketListing({ name: "Listing" })],
      nav: navProps(),
      slugs: ["listing"],
    });
    expect(html).toContain('<div class="admin-nav-group">');
    expect(html).toContain('aria-label="Site menu"');
    expect(html).toContain('<a href="/listings">');
  });

  test("drops the site menu in iframe mode even when one is supplied", () => {
    detectIframeMode(new URL("https://example.com/?iframe=true"));
    const html = ticketPage({
      listings: [ticketListing({ name: "Listing" })],
      nav: navProps(),
      slugs: ["listing"],
    });
    expect(html).toContain('<body class="iframe">');
    expect(html).not.toContain("admin-nav-group");
    expect(html).not.toContain('aria-label="Site menu"');
  });

  test("warns when the page's daily listings share no available date", () => {
    const html = ticketPage({
      cartDateItems: [
        { dates: ["2026-01-01"], id: 1, name: "Near" },
        { dates: ["2026-02-01"], id: 2, name: "Far" },
      ],
      listings: [
        ticketListing({
          id: 1,
          listing_type: "daily",
          name: "Near",
          slug: "near1",
        }),
        ticketListing({
          id: 2,
          listing_type: "daily",
          name: "Far",
          slug: "far01",
        }),
      ],
      slugs: ["near1", "far01"],
    });
    expect(html).toContain(
      "'Near' and 'Far' do not share an available date. Book them separately.",
    );
  });

  test("warns when the page's customisable listings share no booking length", () => {
    const html = ticketPage({
      listings: [
        ticketListing({
          customisable_days: true,
          day_prices: { 1: 500 },
          duration_days: 1,
          id: 1,
          name: "Short",
          slug: "shrt1",
        }),
        ticketListing({
          customisable_days: true,
          day_prices: { 3: 900 },
          duration_days: 3,
          id: 2,
          name: "Long",
          slug: "long1",
        }),
      ],
      slugs: ["shrt1", "long1"],
    });
    expect(html).toContain(
      "'Short' and 'Long' do not share a booking length. Book them separately.",
    );
  });

  test("hides quantity when exactly one open listing allows one ticket", () => {
    const html = ticketPage({
      listings: [
        ticketListing({ id: 1, max_quantity: 1, name: "Available" }),
        listingB(),
      ],
      slugs: ["available", "sold-out"],
    });
    expect(hasInputWithValue(html, "quantity_1", "1")).toBe(true);
    expect(html).not.toContain('class="ticket-listings"');
  });

  test("groups two open one-ticket listings", () => {
    const html = ticketPage({
      listings: [
        ticketListing({ id: 1, max_quantity: 1, name: "First" }),
        ticketListing({ id: 2, max_quantity: 1, name: "Second" }),
      ],
      slugs: ["first", "second"],
    });
    expect(html).toContain(
      '<fieldset class="ticket-listings"><legend>Select Tickets</legend>',
    );
  });

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
        id: 1,
        name: "Tent",
        slug: "tent1",
      }),
      ticketListing({
        id: 2,
        max_quantity: 10,
        name: "Chair",
        slug: "chr12",
      }),
    ];
    const html = ticketPage({
      groupName: "Camp Kit",
      listings,
      packages: [pagePackage(5, [1, 2], { quantities: new Map([[2, 4]]) })],
      slugs: [PKG_SLUG],
    });
    expect(html).toContain('name="package_quantity_5"');
    expect(html).toContain("Number of packages");
    expect(html).toContain("Tent");
    expect(html).toContain("&times;1");
    expect(html).toContain("Chair");
    expect(html).toContain("&times;4");
    expect(html).not.toContain('name="quantity_1"');
  });

  test("limits package day counts to the days its required child supports", () => {
    const parentA = ticketListing({
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800 },
      duration_days: 2,
      id: 1,
      max_quantity: 10,
      name: "Stay",
      slug: "stay1",
    });
    const parentB = ticketListing({
      customisable_days: true,
      day_prices: { 1: 1200, 2: 2000 },
      duration_days: 2,
      id: 2,
      max_quantity: 10,
      name: "Meals",
      slug: "meal1",
    });
    const child = ticketListing({
      duration_days: 1,
      id: 3,
      listing_type: "daily",
      max_quantity: 10,
      name: "Required child",
      slug: "child",
    });
    const html = ticketPage({
      childrenByParentId: new Map([[1, [child]]]),
      listings: [parentA, parentB, child],
      packages: [pagePackage(5, [1, 2])],
      slugs: [PKG_SLUG],
    });
    expect(html).toContain('<option value="1">1 day');
    expect(html).not.toContain('<option value="2">2 days');
  });

  test("restores the submitted package quantity after a validation error", () => {
    setSavedFormData(new FormParams({ package_quantity_5: "3" }));
    try {
      const listings = [
        ticketListing({
          id: 1,
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
      packageGroupRemainingByGroupId: new Map([[7, 4]]),
      packageMemberGroupIds: new Map([
        [1, [7, 8]],
        [2, [7]],
      ]),
      packages: [pagePackage(7, [1, 2], { quantities: new Map([[1, 2]]) })],
      slugs: [PKG_SLUG],
    });
    expect(html).toContain('name="package_quantity_7"');
    expect(html).toContain('<option value="1"');
    expect(html).not.toContain('<option value="2"');
  });

  test("renders a package as sold out when its cap is zero", () => {
    const listings = [
      ticketListing({
        id: 1,
        name: "Big",
        slug: "big01",
      }),
      ticketListing({
        id: 2,
        name: "Small",
        slug: "sml01",
      }),
    ];
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
    expect(html).not.toContain('name="package_quantity');
    expect(html).toContain("Sorry, all listings are sold out.");
  });

  test("keeps a standalone parent's child selector when its package is sold out", () => {
    const parent = ticketListing({
      attendee_count: 0,
      id: 1,
      max_attendees: 100,
      max_quantity: 5,
      name: "Tent",
      slug: "tent1",
    });
    const soldOutSibling = ticketListing({
      attendee_count: 100,
      id: 2,
      max_attendees: 100,
      name: "Chair",
      slug: "chr12",
    });
    const child = ticketListing({
      attendee_count: 0,
      id: 3,
      max_attendees: 100,
      max_quantity: 5,
      name: "Add-on",
      slug: "add01",
    });
    const html = ticketPage({
      childDatesById: new Map(),
      childrenByParentId: new Map([[1, [child]]]),
      listings: [parent, soldOutSibling, child],
      packages: [pagePackage(5, [1, 2], { name: "Camp Kit" })],
      slugs: [PKG_SLUG, "tent1"],
    });
    expect(html).toContain('class="ticket-package sold-out"');
    expect(html).toContain('name="quantity_1"');
    expect(html).toContain('data-parent-id="1"');
  });

  test("caps the package by a SECOND capped group the members share", () => {
    const listings = bigAndSmallListings();
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
        id: 1,
        name: "SecretItem",
        slug: "sec12",
      }),
    ];
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
