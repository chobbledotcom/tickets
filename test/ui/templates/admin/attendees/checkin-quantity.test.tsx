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

  test("each form is a stacked layout with named fields and direction ids", () => {
    const html = renderPage({ checked_in: 1, id: 11, quantity: 3 });

    assertStringIncludes(
      html,
      '<form action="/admin/listing/5/attendee/11/checkin" autocomplete="off" method="POST" class="stack">',
    );
    assertStringIncludes(
      html,
      'name="return_filter" type="hidden" value="all"',
    );
    assertStringIncludes(html, 'name="quantity"');
    assertStringIncludes(html, 'for="checkin-admit-count"');
    assertStringIncludes(
      html,
      '<select id="checkin-admit-count" name="quantity">',
    );
    assertStringIncludes(html, 'for="checkin-release-count"');
    assertStringIncludes(
      html,
      '<select id="checkin-release-count" name="quantity">',
    );
  });

  test("the admit form posts true and the release form posts false", () => {
    const html = renderPage({ checked_in: 1, id: 12, quantity: 3 });

    const admitForm = html.slice(
      html.lastIndexOf("<form", html.indexOf('id="checkin-admit-count"')),
      html.indexOf("</form>", html.indexOf('id="checkin-admit-count"')),
    );
    const releaseForm = html.slice(
      html.lastIndexOf("<form", html.indexOf('id="checkin-release-count"')),
      html.indexOf("</form>", html.indexOf('id="checkin-release-count"')),
    );
    assertStringIncludes(
      admitForm,
      'name="check_in" type="hidden" value="true"',
    );
    assert(!admitForm.includes('value="false"'));
    assertStringIncludes(
      releaseForm,
      'name="check_in" type="hidden" value="false"',
    );
    assert(!releaseForm.includes('value="true"'));
  });

  test("the heading follows the admit direction and the nav highlights the dashboard", () => {
    const partlyAdmitted = renderPage({ checked_in: 1, id: 13, quantity: 3 });

    assertStringIncludes(partlyAdmitted, "<h1>Check in tickets</h1>");
    assert(!partlyAdmitted.includes("Check out tickets</h1>"));
    assertStringIncludes(partlyAdmitted, '<a class="active" href="/admin/">');
    assertStringIncludes(partlyAdmitted, '<div class="prose">');

    const fullyAdmitted = renderPage({ checked_in: 3, id: 14, quantity: 3 });

    assertStringIncludes(fullyAdmitted, "<h1>Check out tickets</h1>");
    assert(!fullyAdmitted.includes("Check in tickets</h1>"));
  });

  test("a line one ticket short still offers the admit direction", () => {
    const html = renderPage({ checked_in: 3, id: 15, quantity: 4 });

    assertStringIncludes(html, "<h1>Check in tickets</h1>");
    assertStringIncludes(html, 'id="checkin-admit-count"');
  });
});
