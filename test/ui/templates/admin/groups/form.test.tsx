import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminGroupNewPage,
  GroupEditPanel,
  type PackageMemberValues,
} from "#templates/admin/groups/form.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testGroup, testListingWithCount } from "#test-utils/factories.ts";
import { useSetting } from "#test-utils/settings.ts";

describe("admin group form templates", () => {
  beforeAll(setupAdminPageTest);
  useSetting({ currency: "GBP" });

  test("renders the create form with empty group fields and no editable slug", () => {
    const html = adminGroupNewPage(OWNER_SESSION, "Fix the group.");

    expect(html).toContain("Fix the group.");
    expect(html).toContain('action="/admin/groups"');
    expect(html).toContain('name="name"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="max_attendees"');
    expect(html).toContain('name="terms_and_conditions"');
    for (const name of ["hidden", "is_package", "hide_package_listings"]) {
      expect(html).toMatch(
        new RegExp(
          `<input(?=[^>]*name="${name}")(?=[^>]*type="checkbox")(?=[^>]*value="1")[^>]*>`,
        ),
      );
    }
    expect(html).not.toContain('value="1" checked');
    expect(html).not.toContain('name="slug"');
    expect(html).toContain("Create Group");
  });

  test("renders saved group values and boolean choices in the edit form", () => {
    const group = testGroup({
      description: "A <strong>group</strong>",
      hidden: true,
      hide_package_listings: true,
      id: 21,
      is_package: true,
      max_attendees: 25,
      name: 'Family "Bundle"',
      slug: "family-bundle",
      terms_and_conditions: "Be kind.",
    });
    const html = String(
      GroupEditPanel({ group, listings: [], members: new Map() }),
    );

    expect(html).toContain('action="/admin/groups/21/edit"');
    expect(html).toContain('value="Family &quot;Bundle&quot;"');
    expect(html).toContain('value="family-bundle"');
    expect(html).toContain("A &lt;strong&gt;group&lt;/strong&gt;");
    expect(html).toContain('name="max_attendees" type="number" value="25"');
    expect(html).toContain("Be kind.");
    for (const name of ["hidden", "is_package", "hide_package_listings"]) {
      expect(html).toContain(`name="${name}" value="1" checked`);
    }
  });

  test("renders package member overrides and defaults without losing a free price", () => {
    const group = testGroup({ id: 3, is_package: true });
    const listings = [
      testListingWithCount({ id: 8, name: "Free override", unit_price: 1250 }),
      testListingWithCount({
        id: 9,
        name: "Listing defaults",
        unit_price: 3400,
      }),
      testListingWithCount({
        id: 10,
        name: "Blank override",
        unit_price: 5600,
      }),
    ];
    const members: PackageMemberValues = new Map([
      [8, { price: 0, quantity: 4 }],
      [10, { price: null, quantity: 2 }],
    ]);
    const html = String(GroupEditPanel({ group, listings, members }));

    expect(html).toMatch(
      /<input(?=[^>]*name="package_price_8")(?=[^>]*placeholder="12.50")(?=[^>]*value="0.00")[^>]*>/,
    );
    expect(html).toMatch(
      /<input(?=[^>]*name="package_qty_8")(?=[^>]*min="1")(?=[^>]*value="4")[^>]*>/,
    );
    expect(html).toMatch(
      /<input(?=[^>]*name="package_price_9")(?=[^>]*placeholder="34.00")(?=[^>]*value="")[^>]*>/,
    );
    expect(html).toMatch(
      /<input(?=[^>]*name="package_qty_9")(?=[^>]*value="1")[^>]*>/,
    );
    expect(html).toMatch(
      /<input(?=[^>]*name="package_price_10")(?=[^>]*placeholder="56.00")(?=[^>]*value="")[^>]*>/,
    );
    expect(html).toMatch(
      /<input(?=[^>]*name="package_qty_10")(?=[^>]*value="2")[^>]*>/,
    );
  });

  test("renders available package day prices with saved values and listing placeholders", () => {
    const group = testGroup({ is_package: true });
    const listing = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 1200, 3: 3000, 7: 7000 },
      duration_days: 3,
      id: 6,
      name: "Flexible stay",
    });
    const members: PackageMemberValues = new Map([
      [
        listing.id,
        {
          dayPrices: new Map([[1, 0]]),
          price: null,
          quantity: 1,
        },
      ],
    ]);
    const html = String(
      GroupEditPanel({ group, listings: [listing], members }),
    );

    expect(html).toMatch(
      /<input(?=[^>]*name="package_day_price_6_1")(?=[^>]*placeholder="12.00")(?=[^>]*value="0.00")[^>]*>/,
    );
    expect(html).toMatch(
      /<input(?=[^>]*name="package_day_price_6_3")(?=[^>]*placeholder="30.00")(?=[^>]*value="")[^>]*>/,
    );
    expect(html).not.toContain("package_day_price_6_7");
    expect(html.indexOf("1-day price")).toBeLessThan(
      html.indexOf("3-day price"),
    );
  });

  test("renders the package member empty state instead of a table", () => {
    const html = String(
      GroupEditPanel({
        group: testGroup({ is_package: true }),
        listings: [],
        members: new Map(),
      }),
    );

    expect(html).toContain(
      "Add listings to this group to set their package prices.",
    );
    expect(html).toMatch(
      /<input(?=[^>]*name="max_attendees")(?![^>]*value=)[^>]*>/,
    );
    expect(html).not.toContain("<table");
    expect(html).not.toContain('name="package_price_');
  });
});
