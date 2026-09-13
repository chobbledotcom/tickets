/** Direct tests for the group Attendees tab panel. */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { GroupAttendeesPanel } from "#templates/admin/groups/attendees.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import {
  testAttendee,
  testGroup,
  testListingWithCount,
} from "#test-utils/factories.ts";

describe("GroupAttendeesPanel", () => {
  beforeAll(setupAdminPageTest);

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
