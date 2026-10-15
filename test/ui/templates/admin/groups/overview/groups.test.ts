import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { ListingMoneyTotals } from "#accounting/listing-money-totals.ts";
import { t } from "#i18n";
import { GroupOverviewPanel } from "#templates/admin/groups/overview.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import {
  sizeQuestionAnswerData,
  testAttendee,
  testGroup,
  testListingWithCount,
} from "#test-utils/factories.ts";

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

describe("group admin panels", () => {
  beforeAll(setupAdminPageTest);

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
      assertStringIncludes(html, "Group Attendees");
      assertStringIncludes(html, "20 / 50");
      assertStringIncludes(html, "30 remain");
      assertStringIncludes(html, "across all listings");
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
      const capCell = groupRow![1];
      assertStringIncludes(capCell ?? "", "(no group cap)");
      assert(
        capCell !== undefined && !capCell.includes("remain"),
        "the value should not contain the searched item",
      );
      assert(
        capCell !== undefined && !capCell.includes(" / "),
        "the value should not contain the searched item",
      );
    });

    test("shows the capacity meter for a cap of one", () => {
      const group = testGroup({ max_attendees: 1, name: "Single Seat" });
      const html = overviewHtml({
        group,
        listings: [testListingWithCount({ attendee_count: 0 })],
      });
      assertStringIncludes(html, "0 / 1");
      assertStringIncludes(html, "1 remain");
      assert(
        !html.includes("(no group cap)"),
        "the value should not contain the searched item",
      );
    });

    test("keeps one space between the meter and its scope note", () => {
      const group = testGroup({ max_attendees: 50 });
      const html = overviewHtml({
        group,
        listings: [testListingWithCount({ attendee_count: 20 })],
      });
      assertStringIncludes(html, "30 remain</span> <small>");
    });

    test("headlines the detail table with the group name across both columns", () => {
      const html = overviewHtml({ group: testGroup({ name: "Named Group" }) });
      assertStringIncludes(html, '<th colspan="2">Named Group</th>');
    });

    test("keeps the hidden row off a group that is not hidden", () => {
      const html = overviewHtml({
        group: testGroup({ hidden: false, name: "Visible Group" }),
      });
      assertStringIncludes(html, "Visible Group");
      assert(
        !html.includes(t("listings_table.yes_not_shown_in_public_list")),
        "the value should not contain the searched item",
      );
    });

    test("Group Attendees row gets danger-text when at cap", () => {
      const group = testGroup({ max_attendees: 10 });
      const html = overviewHtml({
        group,
        listings: [testListingWithCount({ attendee_count: 10 })],
      });
      assertStringIncludes(html, "danger-text");
      assertStringIncludes(html, "10 / 10");
      assertStringIncludes(html, "0 remain");
    });

    test("shows a running-total mismatch for group listings", () => {
      const group = testGroup({ max_attendees: 20 });
      const html = overviewHtml({
        attendees: [
          testAttendee({
            id: 1,
            listing_id: 1,
            price_paid: "2500",
            quantity: 2,
          }),
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
      assertStringIncludes(html, "Running total check");
      assertStringIncludes(html, "expected <strong>2</strong>, got");
      assertStringIncludes(html, "Review group listings");
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
      assertStringIncludes(withRevenue, "Total income earned");

      // Without a paid listing the revenue row is omitted entirely.
      const withoutRevenue = overviewHtml({
        attendees,
        group,
        hasPaidListing: false,
        listings,
      });
      assert(
        !withoutRevenue.includes("Total income earned"),
        "the value should not contain the searched item",
      );
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
          refunds: 1200,
          servicingCosts: 4000,
          transferCount: 3,
        }),
      });
      assertStringIncludes(html, "Money in and out");
      assertStringIncludes(html, "Total income earned");
      assertStringIncludes(html, "+£200");
      assertStringIncludes(html, "Service event costs");
      assertStringIncludes(html, "Refunds");
      assertStringIncludes(html, "−£12");
      assertStringIncludes(html, "−£40");
      assertStringIncludes(html, "Net after refunds and costs");
      assertStringIncludes(html, "£160");
      assert(
        !html.includes("+£160"),
        "the value should not contain the searched item",
      );
      assertStringIncludes(
        html,
        "<strong>Net after refunds and costs</strong>",
      );
      assertStringIncludes(html, 'href="/admin/ledger?group=8"');
      assertStringIncludes(html, "View this group's money changes");
      assertStringIncludes(html, "View every change in the group's money.");
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
      assertStringIncludes(html, "Total income earned");
      assert(
        !html.includes("/admin/ledger?group=8"),
        "the value should not contain the searched item",
      );
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
      assertStringIncludes(html, "Money in and out");
      assertStringIncludes(html, "Service event costs");
      assertStringIncludes(html, "−£30");
      assertStringIncludes(html, 'href="/admin/ledger?group=8"');
    });

    test("shows ledger income in the group detail table", () => {
      const html = overviewHtml({
        group: testGroup({ id: 8 }),
        hasPaidListing: false,
        money: moneyTotals({ recognisedIncome: 2500 }),
      });
      assertStringIncludes(html, "<th>Total Revenue</th><td>£25</td>");
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
      assertStringIncludes(html, "Money in and out");
      assertStringIncludes(
        html,
        '<th>Costs paid outside checkout</th><td class="col-amount">−£30</td>',
      );
      assertStringIncludes(html, 'href="/admin/ledger?group=8"');
    });

    test("suppresses the public URL / QR / embed when the group isn't shareable", () => {
      const group = testGroup({ is_package: true, name: "Sold Out Pkg" });
      const listings = [testListingWithCount({ attendee_count: 0, id: 1 })];

      const shareable = overviewHtml({ group, listings, shareable: true });
      assertStringIncludes(shareable, `localhost/ticket/${group.slug}`);
      assertStringIncludes(shareable, `embed-script-${group.id}`);
      // The Embed action is a label for the hidden toggle, and the embed code
      // rows start hidden, exactly as on the listing page.
      assertStringIncludes(
        shareable,
        `<label class="small-action" for="embed-toggle-${group.id}">Embed</label>`,
      );
      assertStringIncludes(
        shareable,
        `class="visually-hidden embed-toggle" id="embed-toggle-${group.id}" type="checkbox"`,
      );
      expect((shareable.match(/class="embed-code-row"/g) ?? []).length).toBe(2);

      const unshareable = overviewHtml({ group, listings, shareable: false });
      assert(
        !unshareable.includes(`localhost/ticket/${group.slug}`),
        "the value should not contain the searched item",
      );
      assert(
        !unshareable.includes(`embed-script-${group.id}`),
        "the value should not contain the searched item",
      );
      assertStringIncludes(unshareable, "isn't currently bookable");
    });

    test("shows the check-in, revenue, and answer rows the shared stats build", () => {
      const html = overviewHtml({
        attendees: [
          testAttendee({ checked_in: 2, id: 1, listing_id: 1, quantity: 2 }),
        ],
        group: testGroup({ id: 8 }),
        money: moneyTotals({ recognisedIncome: 2500 }),
        questionData: sizeQuestionAnswerData(),
      });
      assertStringIncludes(html, "<th>Total Revenue</th><td>£25</td>");
      assertStringIncludes(html, "<th>Tickets Checked In</th>");
      assertStringIncludes(html, "Size?");
      assertStringIncludes(html, "Small (2), Large (1)");
    });

    test("leaves the answer rows out when the group carries no questions", () => {
      const html = overviewHtml({
        group: testGroup({ id: 8 }),
        money: moneyTotals({ recognisedIncome: 2500 }),
      });
      assertStringIncludes(html, "<th>Total Revenue</th><td>£25</td>");
      assert(
        !html.includes("Size?"),
        "the value should not contain the searched item",
      );
    });

    test("offers ungrouped listings as add-to-group candidates", () => {
      const group = testGroup({ name: "Target" });
      const html = overviewHtml({
        group,
        ungroupedListings: [testListingWithCount({ id: 7, name: "Joinable" })],
      });
      assertStringIncludes(html, "<strong>Add listings:</strong>");
      assertStringIncludes(html, 'value="7"');
      assertStringIncludes(html, "Joinable");
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

    test("greys out a candidate whose type clashes with the members, and says why", () => {
      // The save would refuse this candidate with the group-homogeneity
      // message; the picker says so before the save.
      const group = testGroup({ name: "Target" });
      const html = overviewHtml({
        group,
        listings: [testListingWithCount({ id: 1, listing_type: "standard" })],
        ungroupedListings: [
          testListingWithCount({ id: 7, name: "Joinable" }),
          testListingWithCount({
            id: 8,
            listing_type: "daily",
            name: "Striker",
          }),
        ],
      });
      const joinable = html.indexOf('value="7"');
      const striker = html.indexOf(
        '<input disabled name="listing_ids" type="checkbox" value="8"',
      );
      expect(striker).toBeGreaterThan(joinable);
      assertStringIncludes(
        html,
        t("groups.candidate_type_blocked", {
          candidate: "daily",
          type: "standard",
        }),
      );
    });

    test("greys out a candidate whose customisable-days setting clashes", () => {
      const group = testGroup({ name: "Target" });
      const html = overviewHtml({
        group,
        listings: [
          testListingWithCount({
            customisable_days: false,
            id: 1,
            listing_type: "daily",
          }),
        ],
        ungroupedListings: [
          testListingWithCount({
            customisable_days: true,
            id: 9,
            listing_type: "daily",
            name: "Flexible",
          }),
        ],
      });
      expect(html).toMatch(/<input disabled[^>]*value="9"/);
      assertStringIncludes(html, t("groups.candidate_days_blocked_fixed"));
    });

    test("an enabled candidate carries no disabled marker", () => {
      const group = testGroup({ name: "Bright" });
      const html = overviewHtml({
        group,
        listings: [testListingWithCount({ id: 1, listing_type: "daily" })],
        ungroupedListings: [
          testListingWithCount({ id: 5, listing_type: "daily" }),
        ],
      });
      expect(html).not.toMatch(/<input disabled[^>]*value="5"/);
    });
  });
});
