/**
 * The multi-booking link builder on the admin listings page: what it offers,
 * where it sits, and what it leaves out.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminListingsPage } from "#templates/admin/dashboard.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import type { ListingWithCount } from "#types";

describe("adminListingsPage multi-booking link", () => {
  beforeAll(setupAdminPageTest);

  const renderListingsPage = (
    listings: ListingWithCount[],
    ...expectations: string[]
  ): string => {
    const html = adminListingsPage(listings, OWNER_SESSION);
    for (const expected of expectations) expect(html).toContain(expected);
    return html;
  };

  const expectNoMultiBookingLink = (listings: ListingWithCount[]) => {
    expect(renderListingsPage(listings)).not.toContain("Multi-booking link");
  };

  const twoListings = [
    testListingWithCount({ id: 1, slug: "ab12c" }),
    testListingWithCount({ id: 2, slug: "cd34e" }),
  ];

  const twoListingsWithFields = [
    testListingWithCount({ fields: "email", id: 1, slug: "ab12c" }),
    testListingWithCount({ fields: "email,phone", id: 2, slug: "cd34e" }),
  ];

  test("does not show multi-booking section with zero listings", () => {
    expectNoMultiBookingLink([]);
  });

  test("does not show multi-booking section with one active listing", () => {
    expectNoMultiBookingLink([testListingWithCount({ id: 1, slug: "ab12c" })]);
  });

  test("shows multi-booking section with two active listings", () => {
    renderListingsPage(
      [
        testListingWithCount({ id: 1, name: "Listing A", slug: "ab12c" }),
        testListingWithCount({ id: 2, name: "Listing B", slug: "cd34e" }),
      ],
      "Multi-booking link",
      "Listing A",
      "Listing B",
    );
  });

  test("renders the builder below the deactivated listings", () => {
    const html = adminListingsPage(
      [
        testListingWithCount({ active: true, id: 1, slug: "ab12c" }),
        testListingWithCount({ active: true, id: 2, slug: "cd34e" }),
        testListingWithCount({ active: false, id: 3, name: "Old Show" }),
      ],
      OWNER_SESSION,
    );
    expect(html.indexOf("Multi-booking link")).toBeGreaterThan(
      html.indexOf("Deactivated"),
    );
  });

  test("does not count inactive listings toward threshold", () => {
    expectNoMultiBookingLink([
      testListingWithCount({ active: true, id: 1, slug: "ab12c" }),
      testListingWithCount({ active: false, id: 2, slug: "cd34e" }),
    ]);
  });

  test("excludes inactive listings from checkboxes", () => {
    const html = renderListingsPage(
      [
        testListingWithCount({
          active: true,
          id: 1,
          name: "Active One",
          slug: "ab12c",
        }),
        testListingWithCount({
          active: false,
          id: 2,
          name: "Inactive",
          slug: "cd34e",
        }),
        testListingWithCount({
          active: true,
          id: 3,
          name: "Active Two",
          slug: "ef56g",
        }),
      ],
      "Active One",
      "Active Two",
    );
    expect(html).not.toContain('data-multi-booking-slug="cd34e"');
  });

  test("excludes listings without standalone pages from checkboxes", () => {
    const html = adminListingsPage(
      [
        testListingWithCount({
          active: true,
          id: 1,
          name: "Open",
          slug: "ab12c",
        }),
        testListingWithCount({
          active: true,
          id: 2,
          name: "Hidden Member",
          slug: "cd34e",
        }),
        testListingWithCount({
          active: true,
          id: 3,
          name: "Other",
          slug: "ef56g",
        }),
      ],
      OWNER_SESSION,
      undefined,
      undefined,
      new Set<number>([2]),
    );
    expect(html).toContain('data-multi-booking-slug="ab12c"');
    expect(html).toContain('data-multi-booking-slug="ef56g"');
    expect(html).not.toContain('data-multi-booking-slug="cd34e"');
  });

  test("renders checkboxes with slug data attributes", () => {
    renderListingsPage(
      twoListings,
      'data-multi-booking-slug="ab12c"',
      'data-multi-booking-slug="cd34e"',
    );
  });

  test("renders URL input with domain data attribute", () => {
    renderListingsPage(
      twoListings,
      'data-domain="localhost"',
      "data-multi-booking-url",
      "readonly",
      'for="multi-booking-url"',
      'id="multi-booking-url"',
    );
  });

  test("is collapsed by default via details element", () => {
    renderListingsPage(twoListings, "<details>", "<summary>");
  });

  test("renders embed code inputs", () => {
    renderListingsPage(
      twoListingsWithFields,
      "data-multi-booking-embed-script",
      "data-multi-booking-embed-iframe",
      'for="multi-booking-embed-script"',
      'for="multi-booking-embed-iframe"',
      'id="multi-booking-embed-script"',
      'id="multi-booking-embed-iframe"',
    );
  });

  test("checkboxes include data-fields attribute for embed code generation", () => {
    renderListingsPage(
      twoListingsWithFields,
      'data-fields="email"',
      'data-fields="email,phone"',
    );
  });

  test("keeps the builder based on every active listing while a filter narrows the table", () => {
    const venue = (optionId: number) => ({
      id: 10,
      name: "Venue",
      options: [
        { attribute_id: 10, id: optionId, sort_order: 0, text: "Hall" },
      ],
      sort_order: 0,
    });
    const html = adminListingsPage(
      [
        testListingWithCount({
          active: true,
          id: 1,
          name: "Hall Show",
          slug: "ab12c",
        }),
        testListingWithCount({
          active: true,
          id: 2,
          name: "Field Show",
          slug: "cd34e",
        }),
      ],
      OWNER_SESSION,
      undefined,
      {
        activeAttributeFilters: new Map([[10, 101]]),
        attributeFilters: [
          {
            id: 10,
            name: "Venue",
            options: [
              { id: 101, sort_order: 0, text: "Hall" },
              { id: 102, sort_order: 1, text: "Field" },
            ],
            sort_order: 0,
          },
        ],
        attributesByListing: new Map([
          [1, [venue(101)]],
          [2, [venue(102)]],
        ]),
      },
    );
    // The venue filter narrows the table to the Hall listing...
    expect(html).not.toContain('href="/admin/listing/2"');
    // ...but the builder still offers every active listing.
    expect(html).toContain('data-multi-booking-slug="ab12c"');
    expect(html).toContain('data-multi-booking-slug="cd34e"');
  });
});
