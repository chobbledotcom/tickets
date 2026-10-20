import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { attendeeCheckinQuantityPage } from "#templates/admin/attendees/checkin-quantity.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testAttendee } from "#test-utils/factories.ts";
import type { DisplayAttendee } from "#types";

const renderPage = (attendee: Partial<DisplayAttendee>): string =>
  attendeeCheckinQuantityPage({
    attendee: testAttendee({ listing_id: 5, ...attendee }),
    filter: "all",
    listingName: "Show",
    returnUrl: undefined,
    session: OWNER_SESSION,
  });

describe("attendee check-in quantity page", () => {
  beforeAll(setupAdminPageTest);

  test("offers every count up to the line's quantity, none selected but the whole", () => {
    const html = renderPage({ checked_in: 0, id: 7, quantity: 3 });

    assertStringIncludes(html, "Tickets to check in");
    assertStringIncludes(html, '<option selected value="3">3 tickets</option>');
    for (const option of ["1 ticket", "2 tickets", "3 tickets"]) {
      assertStringIncludes(html, `>${option}</option>`);
    }
    assert(!html.includes("Tickets to check out"));
  });

  test("a partly admitted line offers both directions", () => {
    const html = renderPage({ checked_in: 1, id: 8, quantity: 3 });

    assertStringIncludes(html, "1 of 3 tickets checked in");
    assertStringIncludes(html, '<option selected value="2">2 tickets</option>');
    assertStringIncludes(html, "Tickets to check out");
    assertStringIncludes(html, '<option selected value="1">1 ticket</option>');
  });

  test("a fully admitted line offers only the way out", () => {
    const html = renderPage({ checked_in: 3, id: 9, quantity: 3 });

    assertStringIncludes(html, "3 of 3 tickets checked in");
    assert(!html.includes("Tickets to check in"));
    assertStringIncludes(html, "Tickets to check out");
  });

  test("both forms post the check-in route with their direction", () => {
    const html = renderPage({ checked_in: 1, id: 10, quantity: 3 });

    assertStringIncludes(html, 'action="/admin/listing/5/attendee/10/checkin"');
    assertStringIncludes(html, 'name="check_in" type="hidden" value="true"');
    assertStringIncludes(html, 'name="check_in" type="hidden" value="false"');
  });
});
