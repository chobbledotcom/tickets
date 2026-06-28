import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { adminGroupDetailPage } from "#templates/admin/groups.tsx";
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
    );
    expect(html).toContain("Running total check");
    expect(html).toContain("expected <strong>2</strong>, got");
    expect(html).toContain("Review group listings");
  });
});
