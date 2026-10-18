import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttributeWithOptions } from "#db/attributes.ts";
import { mergePageImageUrls } from "#db/images.ts";
import { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms/saved-data.ts";
import { detectIframeMode } from "#shared/request-context.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
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
import { withRequestContext } from "#test-utils/request-context.ts";

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
  beforeAll(setupAdminPageTest);
  registerPublicTemplateHooks();

  /** The two-member kit every package-section test here shares. */
  const tentAndChairListings = () => [
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
    assertStringIncludes(html, "<title>Group heading</title>");
    assertStringIncludes(html, "<h1>Group heading</h1>");
    assertStringIncludes(html, "<p>Group description</p>");
    assert(!html.includes("Listing description"));
    assertStringIncludes(html, "/image/group.webp");
    assert(!html.includes("/image/listing.webp"));
    assertStringIncludes(html, "Format");
    assertStringIncludes(html, "Outdoor");
    assertStringIncludes(
      html,
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
    assert(!html.includes("Listing description"));
  });

  test("keeps an intentionally empty group name", () => {
    const html = ticketPage({
      groupName: "",
      listings: [ticketListing({ name: "Listing heading" })],
      slugs: ["group-page"],
    });
    assertStringIncludes(html, "<title>Reserve Tickets</title>");
    assert(!html.includes("<h1>Listing heading</h1>"));
  });

  test("hides the header and marks the layout in iframe mode", async () => {
    await withRequestContext(() => {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
      const html = ticketPage({
        groupName: "Iframe-only heading",
        listings: [ticketListing({ name: "Listing" })],
        slugs: ["group-page"],
      });
      assertStringIncludes(
        html,
        '<body class="iframe" data-page-family="public">',
      );
      assertStringIncludes(html, 'class="page-regions public-page"');
      assert(!html.includes("<h1>Iframe-only heading</h1>"));
    });
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
    assert(!html.includes('class="ticket-listings"'));
  });

  test("groups two open one-ticket listings", () => {
    const html = ticketPage({
      listings: [
        ticketListing({ id: 1, max_quantity: 1, name: "First" }),
        ticketListing({ id: 2, max_quantity: 1, name: "Second" }),
      ],
      slugs: ["first", "second"],
    });
    assertStringIncludes(
      html,
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
    assertStringIncludes(html, "Sorry, all listings are sold out.");
    assert(!html.includes("Reserve Tickets</button>"));
  });

  test("renders a package quantity selector and member rows with fixed quantities", () => {
    const listings = tentAndChairListings();
    const html = ticketPage({
      groupName: "Camp Kit",
      listings,
      packages: [pagePackage(5, [1, 2], { quantities: new Map([[2, 4]]) })],
      slugs: [PKG_SLUG],
    });
    assertStringIncludes(html, 'name="package_quantity_5"');
    assertStringIncludes(html, "Number of packages");
    assertStringIncludes(html, "Tent");
    assertStringIncludes(html, "&times;1");
    assertStringIncludes(html, "Chair");
    assertStringIncludes(html, "&times;4");
    assert(!html.includes('name="quantity_1"'));
  });

  test("resolves a package description's img#id reference to the image's uid URL", async () => {
    await withRequestContext(() => {
      mergePageImageUrls(new Map([[9, "/image/kit-uid.webp"]]));
      const html = ticketPage({
        listings: tentAndChairListings(),
        packages: [
          pagePackage(5, [1, 2], {
            description: "![Kit](img#9)",
            quantities: new Map([[2, 4]]),
          }),
          pagePackage(7, [1], { name: "Tent Bundle" }),
        ],
        slugs: [PKG_SLUG],
      });
      expect(html).toContain('<img src="/image/kit-uid.webp" alt="Kit">');
      expect(html).not.toContain("img#9");
    });
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
    assertStringIncludes(html, '<option value="1">1 day');
    assert(!html.includes('<option value="2">2 days'));
  });

  test("restores the submitted package quantity after a validation error", async () => {
    await withRequestContext(() => {
      setSavedFormData(new FormParams({ package_quantity_5: "3" }));
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
      assertStringIncludes(html, 'value="3" selected');
    });
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
    assertStringIncludes(html, 'name="package_quantity_7"');
    assertStringIncludes(html, '<option value="1"');
    assert(!html.includes('<option value="2"'));
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
    assert(!html.includes('name="package_quantity'));
    assertStringIncludes(html, "Sorry, all listings are sold out.");
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
    assertStringIncludes(html, 'class="ticket-package sold-out"');
    assertStringIncludes(html, 'name="quantity_1"');
    assertStringIncludes(html, 'data-parent-id="1"');
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
    assertStringIncludes(html, 'name="package_quantity_7"');
    assertStringIncludes(html, '<option value="1"');
    assert(!html.includes('<option value="2"'));
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
    assertStringIncludes(html, 'name="package_quantity_5"');
    assertStringIncludes(html, "Hidden Bundle");
    assert(!html.includes("SecretItem"));
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
    assertStringIncludes(html, "Format");
    assertStringIncludes(html, "Outdoor");
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
    assertStringIncludes(html, "Beginner");
    assertStringIncludes(html, "Advanced");
  });
});
