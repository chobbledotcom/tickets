import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  adminGroupDetailPage,
  adminGroupEditPage,
} from "#templates/admin/groups.tsx";
import {
  setupTestEncryptionKey,
  testAttendee,
  testGroup,
  testListingWithCount,
} from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminGroupDetailPage", () => {
  test("shows Group Attendees row with cap, count, and remaining", () => {
    const group = testGroup({ max_attendees: 50, name: "Summer Festival" });
    const listings = [
      testListingWithCount({ attendee_count: 12, id: 1 }),
      testListingWithCount({ attendee_count: 8, id: 2 }),
    ];
    const html = adminGroupDetailPage(
      group,
      listings,
      [],
      [],
      TEST_SESSION,
      "localhost",
      false,
      true,
    );
    expect(html).toContain("Group Attendees");
    expect(html).toContain("20 / 50");
    expect(html).toContain("30 remain");
    expect(html).toContain("across all listings");
  });

  test("Group Attendees row drops cap fragment when group is uncapped", () => {
    const group = testGroup({ max_attendees: 0, name: "Open Group" });
    const listings = [testListingWithCount({ attendee_count: 5 })];
    const html = adminGroupDetailPage(
      group,
      listings,
      [],
      [],
      TEST_SESSION,
      "localhost",
      false,
      true,
    );
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
    const listings = [testListingWithCount({ attendee_count: 10 })];
    const html = adminGroupDetailPage(
      group,
      listings,
      [],
      [],
      TEST_SESSION,
      "localhost",
      false,
      true,
    );
    expect(html).toContain("danger-text");
    expect(html).toContain("10 / 10");
    expect(html).toContain("0 remain");
  });

  test("shows a running-total mismatch for group listings", () => {
    const group = testGroup({ max_attendees: 20 });
    const listings = [
      testListingWithCount({
        attendee_count: 9,
        id: 1,
        income: 9000,
        tickets_count: 5,
      }),
    ];
    const attendees = [
      testAttendee({
        id: 1,
        listing_id: 1,
        price_paid: "2500",
        quantity: 2,
      }),
    ];
    const html = adminGroupDetailPage(
      group,
      listings,
      [],
      attendees,
      TEST_SESSION,
      "localhost",
      true,
      true,
    );
    expect(html).toContain("Running total check");
    expect(html).toContain("expected <strong>2</strong>, got");
    expect(html).toContain("Review group listings");
  });

  test("shows Total Revenue row for an override-priced package whose listings are free", () => {
    // An override-priced package charges via package_price even when its member
    // listings are free, so the route passes hasPaidListing=true despite the
    // listings reading as unpaid. The revenue row must still render.
    const group = testGroup({ is_package: true, max_attendees: 20 });
    const listings = [testListingWithCount({ attendee_count: 2, id: 1 })];
    const attendees = [
      testAttendee({ id: 1, listing_id: 1, price_paid: "2500", quantity: 2 }),
    ];
    const withRevenue = adminGroupDetailPage(
      group,
      listings,
      [],
      attendees,
      TEST_SESSION,
      "localhost",
      true,
      true,
    );
    expect(withRevenue).toContain("Total Revenue");

    // Without a paid listing the revenue row is omitted entirely.
    const withoutRevenue = adminGroupDetailPage(
      group,
      listings,
      [],
      attendees,
      TEST_SESSION,
      "localhost",
      false,
      true,
    );
    expect(withoutRevenue).not.toContain("Total Revenue");
  });

  test("suppresses the public URL / QR / embed when the group isn't shareable", () => {
    const group = testGroup({ is_package: true, name: "Sold Out Pkg" });
    const listings = [testListingWithCount({ attendee_count: 0, id: 1 })];

    const shareable = adminGroupDetailPage(
      group,
      listings,
      [],
      [],
      TEST_SESSION,
      "localhost",
      false,
      true,
    );
    expect(shareable).toContain(`localhost/ticket/${group.slug}`);
    expect(shareable).toContain(`embed-script-${group.id}`);

    const unshareable = adminGroupDetailPage(
      group,
      listings,
      [],
      [],
      TEST_SESSION,
      "localhost",
      false,
      false,
    );
    expect(unshareable).not.toContain(`localhost/ticket/${group.slug}`);
    expect(unshareable).not.toContain(`embed-script-${group.id}`);
    expect(unshareable).toContain("isn't currently bookable");
  });
});

describe("adminGroupEditPage package members table", () => {
  test("renders saved overrides and falls back to defaults for members without a row", () => {
    const group = testGroup({ is_package: true, name: "Bundle" });
    const withOverride = testListingWithCount({ id: 1, name: "Priced" });
    const withoutRow = testListingWithCount({ id: 2, name: "Default" });
    // Only listing 1 has a saved member row; listing 2 exercises the
    // member-absent defaults (price → blank, quantity → 1).
    const members = new Map([[1, { price: 1500, quantity: 4 }]]);

    const html = adminGroupEditPage(
      group,
      [withOverride, withoutRow],
      members,
      TEST_SESSION,
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
    const html = adminGroupEditPage(group, [], new Map(), TEST_SESSION);
    expect(html).toContain("Add listings to this group");
  });
});
