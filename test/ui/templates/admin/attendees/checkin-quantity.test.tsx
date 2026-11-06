import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { attendeeCheckinQuantityPage } from "#templates/admin/attendees/checkin-quantity.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
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

    expectIncludesAll(html, [
      "Check in tickets",
      "Tickets to check in",
      '<option selected value="3">3 tickets</option>',
    ]);
    for (const option of ["1 ticket", "2 tickets", "3 tickets"]) {
      assertStringIncludes(html, `>${option}</option>`);
    }
    assert(!html.includes("Tickets to check out"));
    assert(!html.includes("Check out tickets"));
    // The one direction's form: its page frame, the hidden direction and
    // filter fields, and the count select the page reads back.
    expectIncludesAll(html, [
      'class="stack"',
      'class="prose"',
      'id="checkin-admit-count"',
      'name="check_in" type="hidden" value="true"',
      'name="return_filter" type="hidden"',
      'name="quantity"',
      '<a class="active" href="/admin/">Home</a>',
    ]);
  });

  test("a one-place line still reads as the check-in heading", () => {
    const html = renderPage({ checked_in: 2, id: 11, quantity: 3 });

    // One ticket remains, so the page still asks to check it in, and the
    // check-in form is present beside the way out.
    expectIncludesAll(html, [
      "Check in tickets",
      "Tickets to check in",
      'name="check_in" type="hidden" value="true"',
    ]);
  });

  test("a partly admitted line offers both directions", () => {
    const html = renderPage({ checked_in: 1, id: 8, quantity: 3 });

    expectIncludesAll(html, [
      "1 of 3 tickets checked in",
      '<option selected value="2">2 tickets</option>',
      "Tickets to check out",
      '<option selected value="1">1 ticket</option>',
      // The way out is its own form, named and addressed apart from the way in.
      'id="checkin-release-count"',
      'name="check_in" type="hidden" value="false"',
    ]);
  });

  test("a fully admitted line offers only the way out", () => {
    const html = renderPage({ checked_in: 3, id: 9, quantity: 3 });

    assertStringIncludes(html, "3 of 3 tickets checked in");
    assert(!html.includes("Tickets to check in"));
    assertStringIncludes(html, "Tickets to check out");
  });

  test("both forms post the check-in route with their direction", () => {
    const html = renderPage({ checked_in: 1, id: 10, quantity: 3 });

    expectIncludesAll(html, [
      'action="/admin/listing/5/attendee/10/checkin"',
      'name="check_in" type="hidden" value="true"',
      'name="check_in" type="hidden" value="false"',
    ]);
  });

  test("each form is a stacked layout with named fields and direction ids", () => {
    const html = renderPage({ checked_in: 1, id: 11, quantity: 3 });

    expectIncludesAll(html, [
      '<form action="/admin/listing/5/attendee/11/checkin" autocomplete="off" method="POST" class="stack">',
      'name="return_filter" type="hidden" value="all"',
      'name="quantity"',
      'for="checkin-admit-count"',
      '<select id="checkin-admit-count" name="quantity">',
      'for="checkin-release-count"',
      '<select id="checkin-release-count" name="quantity">',
    ]);
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
    expectIncludesAll(partlyAdmitted, [
      '<a class="active" href="/admin/">',
      '<div class="prose">',
    ]);

    const fullyAdmitted = renderPage({ checked_in: 3, id: 14, quantity: 3 });

    assertStringIncludes(fullyAdmitted, "<h1>Check out tickets</h1>");
    assert(!fullyAdmitted.includes("Check in tickets</h1>"));
  });

  test("a line one ticket short still offers the admit direction", () => {
    const html = renderPage({ checked_in: 3, id: 15, quantity: 4 });

    expectIncludesAll(html, [
      "<h1>Check in tickets</h1>",
      'id="checkin-admit-count"',
    ]);
  });
});
