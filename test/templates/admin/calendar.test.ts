import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { generateCalendarCsv } from "#routes/admin/calendar-csv.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { AvailabilityRow } from "#templates/admin/availability-checker.tsx";
import {
  adminCalendarPage,
  type CalendarAttendeeRow,
} from "#templates/admin/calendar.tsx";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import type { DatePickerDate } from "#templates/date-picker.tsx";
import {
  expectTestAttendeeCsvColumns,
  selectOptionLabels,
  setupTestEncryptionKey,
  testAttendee,
} from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

const calendarAttendee = (
  overrides: Partial<CalendarAttendeeRow> = {},
): CalendarAttendeeRow => ({
  ...testAttendee(),
  date: "2026-03-15",
  listingDate: "",
  listingId: 1,
  listingLocation: "",
  listingName: "Daily Listing",
  ...overrides,
});

/** Factory for a {@link DatePickerDate} option in the day dropdown. `selectable`
 *  defaults to `true`; pass `false` for a date whose option is rendered
 *  disabled (e.g. a day with no bookings). */
const calendarDate = (
  label: string,
  value: string,
  selectable = true,
): DatePickerDate => ({ label, selectable, value });

/** Render the admin calendar page with the test constants (`"localhost"`,
 *  owner {@link TEST_SESSION}, today `2026-03-10`) baked in, so each test
 *  only spells out the inputs it actually varies. Optional fields default
 *  to "no attendees, no selected date, no available dates, no availability
 *  checker" — the common empty-calendar case. */
const calendarHtml = (
  overrides: {
    attendees?: CalendarAttendeeRow[];
    dateFilter?: string | null;
    availableDates?: DatePickerDate[];
    today?: string;
    viewMonth?: string | null;
    availabilityRows?: AvailabilityRow[];
  } = {},
): string =>
  adminCalendarPage(
    overrides.attendees ?? [],
    "localhost",
    TEST_SESSION,
    overrides.dateFilter ?? null,
    overrides.availableDates ?? [],
    overrides.today ?? "2026-03-10",
    overrides.viewMonth ?? null,
    undefined,
    undefined,
    false,
    overrides.availabilityRows ?? [],
  );

describe("adminCalendarPage", () => {
  test("renders Calendar title", () => {
    const html = calendarHtml();
    expect(html).toContain("Calendar");
    expect(html).toContain("Attendees by Date");
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

  test("renders Listing column header", () => {
    const html = calendarHtml();
    expect(html).toContain("<th>Listing</th>");
  });

  test("shows CSV export link when date has attendees", () => {
    const html = calendarHtml({
      attendees: [calendarAttendee()],
      dateFilter: "2026-03-15",
    });
    expect(html).toContain('href="/admin/calendar/export?date=2026-03-15"');
    expect(html).toContain("Export CSV");
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
});

describe("generateCalendarCsv", () => {
  test("generates CSV header for empty attendees (no Listing Date/Location columns)", () => {
    const csv = generateCalendarCsv([]);
    expect(csv).toBe(
      "Listing,Type,Date,Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
    );
  });

  test("omits Listing Date and Listing Location columns when all empty", () => {
    const attendees = [calendarAttendee()];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Listing,Type,Date,Name");
    expect(lines[1]).toMatch(/^Daily Listing,Attendee,2026-03-15,/);
  });

  test("shows an inclusive date range for multi-day bookings", () => {
    // end_date is the exclusive end (the 18th), so the booking occupies the
    // 15th through the 17th.
    const attendees = [calendarAttendee({ end_date: "2026-03-18" })];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toMatch(
      /^Daily Listing,Attendee,2026-03-15 to 2026-03-17,/,
    );
  });

  test("includes Listing Date column when some attendees have listing dates", () => {
    const attendees = [
      calendarAttendee({ listingDate: "2026-06-15T14:00:00.000Z" }),
    ];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Listing,Type,Listing Date,Date,Name");
    // The UTC ISO listing datetime is shown as a date + time in the tz
    // (14:00 UTC = 15:00 BST in the default Europe/London timezone).
    expect(lines[1]).toContain("2026-06-15 15:00");
    expect(lines[1]).not.toContain("2026-06-15T14:00:00.000Z");
  });

  test("includes Listing Location column when some attendees have listing locations", () => {
    const attendees = [calendarAttendee({ listingLocation: "Village Hall" })];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Listing,Type,Listing Location,Date,Name");
    expect(lines[1]).toContain("Village Hall");
  });

  test("includes Date column", () => {
    const attendees = [calendarAttendee({ date: "2026-03-20" })];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toContain("2026-03-20");
  });

  test("escapes listing names with commas", () => {
    const attendees = [calendarAttendee({ listingName: "Listing, Special" })];
    const csv = generateCalendarCsv(attendees);
    expect(csv).toContain('"Listing, Special"');
  });

  test("includes standard attendee columns", () => {
    const attendees = [
      calendarAttendee({
        checked_in: true,
        created: "2024-01-15T10:30:00Z",
        payment_id: "pi_abc",
        price_paid: "2000",
        quantity: 2,
      }),
    ];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expectTestAttendeeCsvColumns(lines[1], 2);
    expect(lines[1]).toContain("20.00");
    expect(lines[1]).toContain("pi_abc");
    expect(lines[1]).toContain(",Yes,");
  });

  test("generates multiple rows", () => {
    const attendees = [
      calendarAttendee(),
      calendarAttendee({
        id: 2,
        listingName: "Other Listing",
        name: "Jane Smith",
      }),
    ];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Daily Listing");
    expect(lines[2]).toContain("Other Listing");
  });

  test("handles null date in calendar row", () => {
    const attendees = [calendarAttendee({ date: null })];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toMatch(/^Daily Listing,Attendee,,/);
  });
});

describe("admin nav Calendar link", () => {
  test("admin dashboard includes Calendar link in nav", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).toContain('href="/admin/calendar"');
    expect(html).toContain("Calendar");
  });
});

describe("adminCalendarPage availability checker", () => {
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
