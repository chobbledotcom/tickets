import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { ListingMoneyTotals } from "#shared/accounting/listing-money-totals.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { GroupAttendeesPanel } from "#templates/admin/groups/attendees.tsx";
import { GroupEditPanel } from "#templates/admin/groups/form.tsx";
import { GroupOverviewPanel } from "#templates/admin/groups/overview.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import {
  testAttendee,
  testGroup,
  testListingWithCount,
} from "#test-utils/factories.ts";

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

const moneyTotals = (
  overrides: Partial<ListingMoneyTotals> = {},
): ListingMoneyTotals => ({
  externalCosts: 0,
  externalIncome: 0,
  grossSales: 0,
  manualAdjustments: 0,
  netBalance: 0,
  recognisedIncome: 0,
  refunds: 0,
  servicingCosts: 0,
  transferCount: 0,
  ...overrides,
});

/** Render the Overview panel with sensible defaults for the fields a given test
 * doesn't care about. */
const overviewHtml = (
  overrides: Partial<Parameters<typeof GroupOverviewPanel>[0]> & {
    group: Parameters<typeof GroupOverviewPanel>[0]["group"];
  },
): string =>
  String(
    GroupOverviewPanel({
      allowedDomain: "localhost",
      attendees: [],
      hasPaidListing: false,
      listings: [],
      money: moneyTotals(),
      shareable: true,
      ungroupedListings: [],
      ...overrides,
    }),
  );

describe("GroupOverviewPanel", () => {
  test("shows Group Attendees row with cap, count, and remaining", () => {
    const group = testGroup({ max_attendees: 50, name: "Summer Festival" });
    const html = overviewHtml({
      group,
      listings: [
        testListingWithCount({ attendee_count: 12, id: 1 }),
        testListingWithCount({ attendee_count: 8, id: 2 }),
      ],
    });
    expect(html).toContain("Group Attendees");
    expect(html).toContain("20 / 50");
    expect(html).toContain("30 remain");
    expect(html).toContain("across all listings");
  });

  test("Group Attendees row drops cap fragment when group is uncapped", () => {
    const group = testGroup({ max_attendees: 0, name: "Open Group" });
    const html = overviewHtml({
      group,
      listings: [testListingWithCount({ attendee_count: 5 })],
    });
    const groupRow = html.match(
      /<th>Group Attendees<\/th><td>([\s\S]*?)<\/td>/,
    );
    expect(groupRow).not.toBeNull();
    expect(groupRow![1]).toContain("(no group cap)");
    expect(groupRow![1]).not.toContain("remain");
    expect(groupRow![1]).not.toContain(" / ");
  });

  test("Group Attendees row gets danger-text when at cap", () => {
    const group = testGroup({ max_attendees: 10 });
    const html = overviewHtml({
      group,
      listings: [testListingWithCount({ attendee_count: 10 })],
    });
    expect(html).toContain("danger-text");
    expect(html).toContain("10 / 10");
    expect(html).toContain("0 remain");
  });

  test("shows a running-total mismatch for group listings", () => {
    const group = testGroup({ max_attendees: 20 });
    const html = overviewHtml({
      attendees: [
        testAttendee({ id: 1, listing_id: 1, price_paid: "2500", quantity: 2 }),
      ],
      group,
      hasPaidListing: true,
      listings: [
        testListingWithCount({
          attendee_count: 9,
          id: 1,
          income: 9000,
          tickets_count: 5,
        }),
      ],
    });
    expect(html).toContain("Running total check");
    expect(html).toContain("expected <strong>2</strong>, got");
    expect(html).toContain("Review group listings");
  });

  test("shows income for an override-priced package whose listings are free", () => {
    // An override-priced package charges via package_price even when its member
    // listings are free, so the loader passes hasPaidListing=true despite the
    // listings reading as unpaid. The revenue row must still render.
    const group = testGroup({ is_package: true, max_attendees: 20 });
    const listings = [testListingWithCount({ attendee_count: 2, id: 1 })];
    const attendees = [
      testAttendee({ id: 1, listing_id: 1, price_paid: "2500", quantity: 2 }),
    ];
    const withRevenue = overviewHtml({
      attendees,
      group,
      hasPaidListing: true,
      listings,
    });
    expect(withRevenue).toContain("Total income earned");

    // Without a paid listing the revenue row is omitted entirely.
    const withoutRevenue = overviewHtml({
      attendees,
      group,
      hasPaidListing: false,
      listings,
    });
    expect(withoutRevenue).not.toContain("Total income earned");
  });

  test("summarises group income and servicing costs with a filtered ledger link", () => {
    const group = testGroup({ id: 8, name: "Summer Festival" });
    const html = overviewHtml({
      group,
      hasPaidListing: true,
      ledgerHref: "/admin/ledger?group=8",
      listings: [
        testListingWithCount({ cost: 3000, income: 12000, profit: 9000 }),
        testListingWithCount({ cost: 1000, income: 8000, profit: 7000 }),
      ],
      money: moneyTotals({
        grossSales: 20000,
        netBalance: 20000,
        recognisedIncome: 20000,
        servicingCosts: 4000,
        transferCount: 3,
      }),
    });
    expect(html).toContain("Money in and out");
    expect(html).toContain("Total income earned");
    expect(html).toContain("+£200");
    expect(html).toContain("Service event costs");
    expect(html).toContain("−£40");
    expect(html).toContain("Net after refunds and costs");
    expect(html).toContain("£160");
    expect(html).toContain('href="/admin/ledger?group=8"');
    expect(html).toContain("View group money history");
    expect(html).toContain("View every change in the group's money history.");
  });

  test("does not offer a forbidden ledger link without owner access", () => {
    const html = overviewHtml({
      group: testGroup({ id: 8 }),
      hasPaidListing: true,
      listings: [testListingWithCount({ income: 12000 })],
      money: moneyTotals({
        grossSales: 12000,
        netBalance: 12000,
        recognisedIncome: 12000,
        transferCount: 1,
      }),
    });
    expect(html).toContain("Total income earned");
    expect(html).not.toContain("/admin/ledger?group=8");
  });

  test("shows money and its ledger link for a free group with only costs", () => {
    const html = overviewHtml({
      group: testGroup({ id: 8 }),
      hasPaidListing: false,
      ledgerHref: "/admin/ledger?group=8",
      listings: [testListingWithCount({ cost: 3000, profit: -3000 })],
      money: moneyTotals({
        servicingCosts: 3000,
        transferCount: 1,
      }),
    });
    expect(html).toContain("Money in and out");
    expect(html).toContain("Service event costs");
    expect(html).toContain("−£30");
    expect(html).toContain('href="/admin/ledger?group=8"');
  });

  test("shows money and its ledger link for a free group with only outside costs", () => {
    const html = overviewHtml({
      group: testGroup({ id: 8 }),
      hasPaidListing: false,
      ledgerHref: "/admin/ledger?group=8",
      money: moneyTotals({
        externalCosts: 3000,
        netBalance: -3000,
        transferCount: 1,
      }),
    });
    expect(html).toContain("Money in and out");
    expect(html).toContain("Costs paid outside checkout");
    expect(html).toContain("−£30");
    expect(html).toContain('href="/admin/ledger?group=8"');
  });

  test("suppresses the public URL / QR / embed when the group isn't shareable", () => {
    const group = testGroup({ is_package: true, name: "Sold Out Pkg" });
    const listings = [testListingWithCount({ attendee_count: 0, id: 1 })];

    const shareable = overviewHtml({ group, listings, shareable: true });
    expect(shareable).toContain(`localhost/ticket/${group.slug}`);
    expect(shareable).toContain(`embed-script-${group.id}`);

    const unshareable = overviewHtml({ group, listings, shareable: false });
    expect(unshareable).not.toContain(`localhost/ticket/${group.slug}`);
    expect(unshareable).not.toContain(`embed-script-${group.id}`);
    expect(unshareable).toContain("isn't currently bookable");
  });

  test("offers ungrouped listings as add-to-group candidates", () => {
    const group = testGroup({ name: "Target" });
    const html = overviewHtml({
      group,
      ungroupedListings: [testListingWithCount({ id: 7, name: "Joinable" })],
    });
    expect(html).toContain("<strong>Add listings:</strong>");
    expect(html).toContain('value="7"');
    expect(html).toContain("Joinable");
  });

  test("shows deactivated candidates muted and last in the add-to-group list", () => {
    const group = testGroup({ name: "Target" });
    const html = overviewHtml({
      group,
      ungroupedListings: [
        testListingWithCount({ active: false, id: 7, name: "Retired" }),
        testListingWithCount({ active: true, id: 8, name: "Live" }),
      ],
    });
    const live = html.indexOf('value="8"');
    const retired = html.indexOf(
      '<label class="muted"><input name="listing_ids" type="checkbox" value="7"',
    );
    expect(live).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(live);
  });
});

describe("GroupAttendeesPanel", () => {
  test("keeps one attendee row per booking line, each with its own check-in action", () => {
    const group = testGroup({ name: "Roster Group" });
    const listings = [
      testListingWithCount({ id: 1, name: "First Listing" }),
      testListingWithCount({ id: 2, name: "Second Listing" }),
    ];
    const attendees = [
      testAttendee({ id: 9, listing_id: 1, name: "Repeat Visitor" }),
      testAttendee({ id: 9, listing_id: 2, name: "Repeat Visitor" }),
    ];
    const html = String(
      GroupAttendeesPanel({
        allowedDomain: "localhost",
        attendees,
        group,
        listings,
      }),
    );
    // Per-line check-in is the point of this roster: the attendee's two
    // bookings stay two rows, each acting on its own listing.
    expect(html).toContain("/admin/listing/1/attendee/9/checkin");
    expect(html).toContain("/admin/listing/2/attendee/9/checkin");
    expect(html).toContain('title="First Listing"');
    expect(html).toContain('title="Second Listing"');
  });

  test("returns operator actions to the Attendees tab, not the old detail anchor", () => {
    const group = testGroup({ id: 5, name: "Return Group" });
    const listings = [testListingWithCount({ id: 1, name: "Only Listing" })];
    const html = String(
      GroupAttendeesPanel({
        allowedDomain: "localhost",
        attendees: [testAttendee({ id: 3, listing_id: 1, name: "Guest" })],
        group,
        listings,
      }),
    );
    expect(html).toContain('name="return_url"');
    expect(html).toContain('value="/admin/groups/5/attendees"');
  });
});

describe("GroupEditPanel package members table", () => {
  test("renders saved overrides and falls back to defaults for members without a row", () => {
    const group = testGroup({ is_package: true, name: "Bundle" });
    const withOverride = testListingWithCount({ id: 1, name: "Priced" });
    const withoutRow = testListingWithCount({ id: 2, name: "Default" });
    // Only listing 1 has a saved member row; listing 2 exercises the
    // member-absent defaults (price → blank, quantity → 1).
    const members = new Map([[1, { price: 1500, quantity: 4 }]]);

    const html = String(
      GroupEditPanel({ group, listings: [withOverride, withoutRow], members }),
    );
    expect(html).toContain('name="package_price_1"');
    expect(html).toContain('value="15.00"');
    expect(html).toContain('name="package_qty_1"');
    expect(html).toContain('value="4"');
    // Listing 2 (no row): blank price, quantity defaults to 1.
    expect(html).toContain('name="package_price_2"');
    expect(html).toContain('name="package_qty_2"');
    expect(html).toContain('value="1"');
  });

  test("shows the empty-state prompt when the package has no listings", () => {
    const group = testGroup({ is_package: true, name: "Empty" });
    const html = String(
      GroupEditPanel({ group, listings: [], members: new Map() }),
    );
    expect(html).toContain("Add listings to this group");
  });

  test("does not link to the JSON export (that now lives on the Actions tab)", () => {
    const group = testGroup({ id: 7, name: "Exportable" });
    const html = String(
      GroupEditPanel({ group, listings: [], members: new Map() }),
    );
    // The Actions tab is now editor-visible too, so the export link lives
    // only there — the Edit panel no longer duplicates it.
    expect(html).not.toContain(`/admin/groups/${group.id}/export.json`);
  });
});
