import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import type { AvailabilityRow } from "#templates/admin/availability-checker.tsx";
import { adminCalendarPage } from "#templates/admin/calendar.tsx";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { selectOptionLabels } from "#test-utils/assertions.ts";
import { shownLineBookings } from "#test-utils/attendees/pair-bookings.ts";
import {
  calendarAttendee,
  calendarDate,
  calendarHtml,
} from "./calendar/helpers.ts";

describe("adminCalendarPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders Calendar title", () => {
    const html = calendarHtml();
    assertStringIncludes(html, "Calendar");
    assert(!html.includes("Attendees by Date"));
    assertStringIncludes(html, '<article id="attendees">');
  });

  test("renders date selector dropdown", () => {
    const dates = [
      calendarDate("Sunday 15 March 2026", "2026-03-15"),
      calendarDate("Monday 16 March 2026", "2026-03-16", false),
    ];
    const html = calendarHtml({ availableDates: dates });
    assertStringIncludes(html, "Sunday 15 March 2026");
    assertStringIncludes(html, "Monday 16 March 2026");
    assertStringIncludes(html, "Select a date");
  });

  test("disables options for dates without bookings", () => {
    const html = calendarHtml({
      availableDates: [
        calendarDate("Sunday 15 March 2026", "2026-03-15", false),
      ],
    });
    assertStringIncludes(html, "<option disabled>");
  });

  test("enables options for dates with bookings", () => {
    const html = calendarHtml({
      availableDates: [calendarDate("Sunday 15 March 2026", "2026-03-15")],
    });
    assertStringIncludes(
      html,
      'value="/admin/calendar?date=2026-03-15#attendees"',
    );
  });

  test("shows prompt when no date selected", () => {
    const html = calendarHtml();
    assertStringIncludes(html, "Select a date above to view attendees");
  });

  test("shows no attendees message when date selected but empty", () => {
    const html = calendarHtml({ dateFilter: "2026-03-15" });
    assertStringIncludes(html, "No attendees for this date");
  });

  test("shows formatted date label when date is selected", () => {
    const html = calendarHtml({ dateFilter: "2026-03-15" });
    assertStringIncludes(html, "Sunday 15 March 2026");
  });

  test("renders attendee rows with listing name and link", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee()],
      dateFilter: "2026-03-15",
    });
    assertStringIncludes(html, "Daily Listing");
    assertStringIncludes(html, 'href="/admin/listing/1"');
    assertStringIncludes(html, "John Doe");
  });

  test("renders Listings column header", () => {
    const html = calendarHtml();
    assertStringIncludes(html, "<th>Listings</th>");
  });

  test("shows CSV export link when date has attendees", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee()],
      dateFilter: "2026-03-15",
    });
    assertStringIncludes(
      html,
      '<div class="table-actions"><a href="/admin/calendar/export?date=2026-03-15">',
    );
    assertStringIncludes(html, "Export CSV");
  });

  test("renders the roster with no date column, plain count, no revenue", () => {
    // The day is already chosen and listings carry their own dates, so the
    // roster omits the Date column, and a day holds no capacity or revenue.
    const attendees = [calendarAttendee()];
    const html = adminCalendarPage(
      attendees,
      shownLineBookings(attendees),
      "localhost",
      OWNER_SESSION,
      "2026-03-15",
      [],
      "2026-03-10",
    );
    assert(!html.includes("<th>Date</th>"));
    assertStringIncludes(html, "Attendees</th><td>1</td>");
    assert(!html.includes("Total Revenue"));
  });

  test("does not show CSV export when date has no attendees", () => {
    const html = calendarHtml({ dateFilter: "2026-03-15" });
    assert(!html.includes("Export CSV"));
  });

  test("does not show CSV export when no date selected", () => {
    const html = calendarHtml();
    assert(!html.includes("Export CSV"));
  });

  test("shows the agent filter bar with a link per agent", () => {
    const html = calendarHtml({
      agents: [{ id: 3, name: "Van 1" }],
    });
    assertStringIncludes(html, "Agent");
    // A specific agent's link carries the agent param and the #attendees
    // anchor, so the roster's own filter and the page's section agree.
    assertStringIncludes(
      html,
      'href="/admin/calendar?agent=3#attendees"',
    );
  });

  test("omits the agent filter bar when no agents exist", () => {
    const html = calendarHtml();
    assert(!html.includes(">Agent<"));
    assert(!html.includes("agent="));
  });

  test("includes Calendar link in admin nav", () => {
    const html = calendarHtml();
    assertStringIncludes(html, 'href="/admin/calendar"');
  });

  test("marks the calendar link as the page the operator is on", () => {
    const html = calendarHtml();
    assertStringIncludes(html, 'class="active" href="/admin/calendar"');
  });

  test("renders the shared detail rows only for a day with attendees", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee()],
      dateFilter: "2026-03-15",
    });
    assertStringIncludes(html, "listing-details-table");
    assertStringIncludes(html, "Checked In");
    // No capacity is set for a day, so the count is a plain number and the
    // calendar page never claims revenue (the roster does not know it).
    assertStringIncludes(html, "Attendees</");
    assert(!html.includes("Total Revenue"));
  });

  test("omits the shared detail rows when the day has no attendees", () => {
    const html = calendarHtml({ dateFilter: "2026-03-15" });
    assert(!html.includes("listing-details-table"));
    assert(!calendarHtml().includes("listing-details-table"));
  });

  test("renders empty string for attendee without email", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee({ email: "" })],
      dateFilter: "2026-03-15",
    });
    assertStringIncludes(html, "John Doe");
  });

  test("escapes attendee data", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee({ name: "<script>evil()</script>" })],
      dateFilter: "2026-03-15",
    });
    assertStringIncludes(html, "&lt;script&gt;");
  });

  test("places Select a date between past and future dates", () => {
    const dates = [
      calendarDate("Sunday 8 March 2026", "2026-03-08"),
      calendarDate("Monday 9 March 2026", "2026-03-09"),
      calendarDate("Sunday 15 March 2026", "2026-03-15"),
      calendarDate("Monday 16 March 2026", "2026-03-16"),
    ];
    const html = calendarHtml({ availableDates: dates });
    expect(selectOptionLabels(html, "Select a date")).toEqual([
      "Sunday 8 March 2026",
      "Monday 9 March 2026",
      "Select a date",
      "Sunday 15 March 2026",
      "Monday 16 March 2026",
    ]);
  });

  test("places Select a date at end when all dates are past", () => {
    const dates = [
      calendarDate("Sunday 8 March 2026", "2026-03-08"),
      calendarDate("Monday 9 March 2026", "2026-03-09"),
    ];
    const html = calendarHtml({ availableDates: dates });
    expect(selectOptionLabels(html, "Select a date")).toEqual([
      "Sunday 8 March 2026",
      "Monday 9 March 2026",
      "Select a date",
    ]);
  });

  test("places Select a date at start when all dates are future", () => {
    const dates = [
      calendarDate("Sunday 15 March 2026", "2026-03-15"),
      calendarDate("Monday 16 March 2026", "2026-03-16"),
    ];
    const html = calendarHtml({ availableDates: dates });
    expect(selectOptionLabels(html, "Select a date")).toEqual([
      "Select a date",
      "Sunday 15 March 2026",
      "Monday 16 March 2026",
    ]);
  });

  test("renders the calendar grid above the dropdown", () => {
    const html = calendarHtml({
      availableDates: [calendarDate("Sunday 15 March 2026", "2026-03-15")],
    });
    assertStringIncludes(html, 'class="calendar"');
    assertStringIncludes(html, "calendar-grid");
    expect(html.indexOf('class="calendar"')).toBeLessThan(
      html.indexOf('aria-label="Select a date"'),
    );
  });

  test("calendar day for a selectable date links to that date", () => {
    const html = calendarHtml({
      availableDates: [calendarDate("Thursday 12 March 2026", "2026-03-12")],
    });
    assertStringIncludes(
      html,
      'href="/admin/calendar?date=2026-03-12#attendees"',
    );
  });

  test("calendar shows the selected date's month", () => {
    const html = calendarHtml({
      dateFilter: "2026-03-15",
      today: "2026-01-10",
    });
    expect(html).toMatch(/<option selected[^>]*>March 2026<\/option>/);
  });

  test("calendar respects the view month parameter", () => {
    const html = calendarHtml({ viewMonth: "2026-08" });
    expect(html).toMatch(/<option selected[^>]*>August 2026<\/option>/);
  });

  test("month navigation links preserve the selected date", () => {
    const html = calendarHtml({ dateFilter: "2026-03-15" });
    // The selected date rides along on the month-paging links so paging
    // months never clears the current selection.
    assertStringIncludes(html, "date=2026-03-15&amp;cal=");
  });

  test("every in-page link returns to the calendar's attendee list", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee()],
      dateFilter: "2026-03-15",
    });
    assertStringIncludes(
      html,
      'name="return_url" type="hidden" value="/admin/calendar?date=2026-03-15#attendees"',
    );
    assertStringIncludes(html, 'value="/admin/calendar#attendees"');
    expect(html).toMatch(
      /#calendar">(?:January|February|March) 2026<\/option>/,
    );
    assertStringIncludes(html, 'href="/admin/guide#calendar"');
  });
});

describe("admin nav Calendar link", () => {
  beforeAll(setupAdminPageTest);

  test("admin dashboard includes Calendar link in nav", () => {
    const html = adminDashboardPage([], OWNER_SESSION);
    assertStringIncludes(html, 'href="/admin/calendar"');
    assertStringIncludes(html, "Calendar");
  });
});

describe("adminCalendarPage availability checker", () => {
  beforeAll(setupAdminPageTest);

  const availabilityRow = (
    overrides: Partial<AvailabilityRow> = {},
  ): AvailabilityRow => ({
    canPayMore: false,
    id: 1,
    name: "Listing",
    remaining: 3,
    total: 5,
    unitPrice: 1000,
    ...overrides,
  });

  const checkerHtml = (
    rows: AvailabilityRow[],
    dateFilter: string | null = null,
  ): string => calendarHtml({ availabilityRows: rows, dateFilter });

  test("renders a closed disclosure with a selectable row per listing", () => {
    const html = checkerHtml([
      availabilityRow({ id: 7, name: "Kayak Hire", remaining: 3, total: 5 }),
    ]);
    assertStringIncludes(html, "Check availability");
    assertStringIncludes(html, "data-availability-checker");
    assertStringIncludes(html, 'href="/admin/listing/7"');
    assertStringIncludes(html, "Kayak Hire");
    assertStringIncludes(html, "3/5");
    assertStringIncludes(html, 'name="select_7"');
    assertStringIncludes(html, 'action="/admin/attendees/new"');
    assertStringIncludes(html, 'formaction="/admin/servicing/new"');
    assertStringIncludes(html, "Create Service Event");
  });

  test("marks a sold-out row as danger", () => {
    const html = checkerHtml([
      availabilityRow({ id: 8, remaining: 0, total: 2 }),
    ]);
    assertStringIncludes(html, "0/2");
    assertStringIncludes(html, 'class="col-quantity danger"');
  });

  test("shows Free, From and plain prices", () => {
    const html = checkerHtml([
      availabilityRow({ id: 1, unitPrice: 0 }),
      availabilityRow({ canPayMore: true, id: 2, unitPrice: 500 }),
      availabilityRow({ canPayMore: false, id: 3, unitPrice: 1000 }),
    ]);
    assertStringIncludes(html, "Free");
    assertStringIncludes(html, `From ${formatCurrency(500)}`);
    assertStringIncludes(html, formatCurrency(1000));
  });

  test("includes the selected date as a hidden start_date field", () => {
    const html = checkerHtml([availabilityRow()], "2026-03-15");
    assertStringIncludes(html, 'name="start_date"');
    assertStringIncludes(html, 'value="2026-03-15"');
  });

  test("omits start_date when no date is selected", () => {
    const html = checkerHtml([availabilityRow()]);
    assert(!html.includes('name="start_date"'));
  });

  test("shows a fallback when there are no bookable listings", () => {
    const html = checkerHtml([]);
    assertStringIncludes(html, "Check availability");
    assertStringIncludes(html, "No bookable listings");
  });
});
