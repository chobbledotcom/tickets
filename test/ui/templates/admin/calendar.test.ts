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
import {
  calendarAttendee,
  calendarDate,
  calendarHtml,
} from "./calendar/helpers.ts";

describe("adminCalendarPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders Calendar title", () => {
    const html = calendarHtml();
    expect(html).toContain("Calendar");
    expect(html).not.toContain("Attendees by Date");
    expect(html).toContain('<article id="attendees">');
  });

  test("renders date selector dropdown", () => {
    const dates = [
      calendarDate("Sunday 15 March 2026", "2026-03-15"),
      calendarDate("Monday 16 March 2026", "2026-03-16", false),
    ];
    const html = calendarHtml({ availableDates: dates });
    expect(html).toContain("Sunday 15 March 2026");
    expect(html).toContain("Monday 16 March 2026");
    expect(html).toContain("Select a date");
  });

  test("disables options for dates without bookings", () => {
    const html = calendarHtml({
      availableDates: [
        calendarDate("Sunday 15 March 2026", "2026-03-15", false),
      ],
    });
    expect(html).toContain("<option disabled>");
  });

  test("enables options for dates with bookings", () => {
    const html = calendarHtml({
      availableDates: [calendarDate("Sunday 15 March 2026", "2026-03-15")],
    });
    expect(html).toContain('value="/admin/calendar?date=2026-03-15#attendees"');
  });

  test("shows prompt when no date selected", () => {
    const html = calendarHtml();
    expect(html).toContain("Select a date above to view attendees");
  });

  test("shows no attendees message when date selected but empty", () => {
    const html = calendarHtml({ dateFilter: "2026-03-15" });
    expect(html).toContain("No attendees for this date");
  });

  test("shows formatted date label when date is selected", () => {
    const html = calendarHtml({ dateFilter: "2026-03-15" });
    expect(html).toContain("Sunday 15 March 2026");
  });

  test("renders attendee rows with listing name and link", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee()],
      dateFilter: "2026-03-15",
    });
    expect(html).toContain("Daily Listing");
    expect(html).toContain('href="/admin/listing/1"');
    expect(html).toContain("John Doe");
  });

  test("renders Listings column header", () => {
    const html = calendarHtml();
    expect(html).toContain("<th>Listings</th>");
  });

  test("shows CSV export link when date has attendees", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee()],
      dateFilter: "2026-03-15",
    });
    expect(html).toContain(
      '<div class="table-actions"><a href="/admin/calendar/export?date=2026-03-15">',
    );
    expect(html).toContain("Export CSV");
  });

  test("renders the roster with no date column, plain count, no revenue", () => {
    // The day is already chosen and listings carry their own dates, so the
    // roster omits the Date column, and a day holds no capacity or revenue.
    const html = adminCalendarPage(
      [calendarAttendee()],
      "localhost",
      OWNER_SESSION,
      "2026-03-15",
      [],
      "2026-03-10",
    );
    expect(html).not.toContain("<th>Date</th>");
    expect(html).toContain("Attendees</th><td>1</td>");
    expect(html).not.toContain("Total Revenue");
  });

  test("does not show CSV export when date has no attendees", () => {
    const html = calendarHtml({ dateFilter: "2026-03-15" });
    expect(html).not.toContain("Export CSV");
  });

  test("does not show CSV export when no date selected", () => {
    const html = calendarHtml();
    expect(html).not.toContain("Export CSV");
  });

  test("includes Calendar link in admin nav", () => {
    const html = calendarHtml();
    expect(html).toContain('href="/admin/calendar"');
  });

  test("marks the calendar link as the page the operator is on", () => {
    const html = calendarHtml();
    expect(html).toContain('class="active" href="/admin/calendar"');
  });

  test("renders the shared detail rows only for a day with attendees", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee()],
      dateFilter: "2026-03-15",
    });
    expect(html).toContain("listing-details-table");
    expect(html).toContain("Checked In");
    // No capacity is set for a day, so the count is a plain number and the
    // calendar page never claims revenue (the roster does not know it).
    expect(html).toContain("Attendees</");
    expect(html).not.toContain("Total Revenue");
  });

  test("omits the shared detail rows when the day has no attendees", () => {
    const html = calendarHtml({ dateFilter: "2026-03-15" });
    expect(html).not.toContain("listing-details-table");
    expect(calendarHtml()).not.toContain("listing-details-table");
  });

  test("renders empty string for attendee without email", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee({ email: "" })],
      dateFilter: "2026-03-15",
    });
    expect(html).toContain("John Doe");
  });

  test("escapes attendee data", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee({ name: "<script>evil()</script>" })],
      dateFilter: "2026-03-15",
    });
    expect(html).toContain("&lt;script&gt;");
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
    expect(html).toContain('class="calendar"');
    expect(html).toContain("calendar-grid");
    expect(html.indexOf('class="calendar"')).toBeLessThan(
      html.indexOf('aria-label="Select a date"'),
    );
  });

  test("calendar day for a selectable date links to that date", () => {
    const html = calendarHtml({
      availableDates: [calendarDate("Thursday 12 March 2026", "2026-03-12")],
    });
    expect(html).toContain('href="/admin/calendar?date=2026-03-12#attendees"');
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
    expect(html).toContain("date=2026-03-15&amp;cal=");
  });

  test("every in-page link returns to the calendar's attendee list", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee()],
      dateFilter: "2026-03-15",
    });
    expect(html).toContain(
      'name="return_url" type="hidden" value="/admin/calendar?date=2026-03-15#attendees"',
    );
    expect(html).toContain('value="/admin/calendar#attendees"');
    expect(html).toMatch(
      /#calendar">(?:January|February|March) 2026<\/option>/,
    );
    expect(html).toContain('href="/admin/guide#calendar"');
  });
});

describe("admin nav Calendar link", () => {
  beforeAll(setupAdminPageTest);

  test("admin dashboard includes Calendar link in nav", () => {
    const html = adminDashboardPage([], OWNER_SESSION);
    expect(html).toContain('href="/admin/calendar"');
    expect(html).toContain("Calendar");
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
    expect(html).toContain("Check availability");
    expect(html).toContain("data-availability-checker");
    expect(html).toContain('href="/admin/listing/7"');
    expect(html).toContain("Kayak Hire");
    expect(html).toContain("3/5");
    expect(html).toContain('name="select_7"');
    expect(html).toContain('action="/admin/attendees/new"');
    expect(html).toContain('formaction="/admin/servicing/new"');
    expect(html).toContain("Create Service Event");
  });

  test("marks a sold-out row as danger", () => {
    const html = checkerHtml([
      availabilityRow({ id: 8, remaining: 0, total: 2 }),
    ]);
    expect(html).toContain("0/2");
    expect(html).toContain('class="col-quantity danger"');
  });

  test("shows Free, From and plain prices", () => {
    const html = checkerHtml([
      availabilityRow({ id: 1, unitPrice: 0 }),
      availabilityRow({ canPayMore: true, id: 2, unitPrice: 500 }),
      availabilityRow({ canPayMore: false, id: 3, unitPrice: 1000 }),
    ]);
    expect(html).toContain("Free");
    expect(html).toContain(`From ${formatCurrency(500)}`);
    expect(html).toContain(formatCurrency(1000));
  });

  test("includes the selected date as a hidden start_date field", () => {
    const html = checkerHtml([availabilityRow()], "2026-03-15");
    expect(html).toContain('name="start_date"');
    expect(html).toContain('value="2026-03-15"');
  });

  test("omits start_date when no date is selected", () => {
    const html = checkerHtml([availabilityRow()]);
    expect(html).not.toContain('name="start_date"');
  });

  test("shows a fallback when there are no bookable listings", () => {
    const html = checkerHtml([]);
    expect(html).toContain("Check availability");
    expect(html).toContain("No bookable listings");
  });
});
