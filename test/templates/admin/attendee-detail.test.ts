import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttendeeBooking } from "#routes/admin/attendee-form-model.ts";
import { formatDateRangeLabel } from "#shared/dates.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import {
  AttendeeAnswersTable,
  AttendeeBookingsTable,
  AttendeeDetail,
  AttendeeLogSection,
  BookingStatusBadges,
} from "#templates/admin/attendee-detail.tsx";
import { setupTestEncryptionKey, testAttendee } from "#test-utils";

const booking = (
  overrides: Partial<AttendeeBooking> = {},
): AttendeeBooking => ({
  checkedIn: false,
  endAt: null,
  listingActive: true,
  listingId: 1,
  listingName: "Test Listing",
  quantity: 1,
  refunded: false,
  startAt: null,
  ...overrides,
});

const renderBookings = (bookings: AttendeeBooking[]): string =>
  String(AttendeeBookingsTable({ bookings }));

const ALLOWED_DOMAIN = "tickets.example.com";

const renderDetail = (attendee = testAttendee(), phonePrefix = "44"): string =>
  String(
    AttendeeDetail({ allowedDomain: ALLOWED_DOMAIN, attendee, phonePrefix }),
  );

beforeAll(() => {
  setupTestEncryptionKey();
});

describe("AttendeeDetail", () => {
  test("always shows name, ticket link and registered", () => {
    const html = renderDetail(
      testAttendee({ name: "Jane Doe", ticket_token: "tok-123" }),
    );
    expect(html).toContain('<th scope="row">Name</th>');
    expect(html).toContain("Jane Doe");
    expect(html).toContain(`https://${ALLOWED_DOMAIN}/t/tok-123`);
    expect(html).toContain("Registered");
  });

  test("renders email as a mailto link when present", () => {
    const html = renderDetail(testAttendee({ email: "jane@example.com" }));
    expect(html).toContain('href="mailto:jane@example.com"');
  });

  test("omits the email row when there is no email", () => {
    const html = renderDetail(testAttendee({ email: "" }));
    expect(html).not.toContain("Email");
  });

  test("shows the phone number with small tel and whatsapp links", () => {
    const html = renderDetail(testAttendee({ phone: "07700 900000" }));
    expect(html).toContain("07700 900000");
    expect(html).toContain('<a href="tel:+447700900000">tel</a>');
    expect(html).toContain("https://wa.me/447700900000");
    expect(html).toContain("<small>");
  });

  test("normalises the phone with the given dialling code", () => {
    const html = renderDetail(testAttendee({ phone: "0234 567 8900" }), "1");
    expect(html).toContain('href="tel:+12345678900"');
    expect(html).toContain("https://wa.me/12345678900");
  });

  test("omits the phone row when there is no phone", () => {
    const html = renderDetail(testAttendee({ phone: "" }));
    expect(html).not.toContain("Phone");
    expect(html).not.toContain("tel:");
  });

  test("preserves line breaks for address and special instructions", () => {
    const html = renderDetail(
      testAttendee({
        address: "1 High St\nTownsville",
        special_instructions: "Step free\nNut allergy",
      }),
    );
    expect(html).toContain("white-space:pre-wrap");
    expect(html).toContain("1 High St\nTownsville");
    expect(html).toContain("Step free\nNut allergy");
  });
});

describe("BookingStatusBadges", () => {
  test("returns null when the booking is neither checked in nor refunded", () => {
    // Null lets the table swap in an em dash for the status cell.
    expect(
      BookingStatusBadges({ checkedIn: false, refunded: false }),
    ).toBeNull();
  });

  test("renders a plain badge when checked in", () => {
    const html = String(
      BookingStatusBadges({ checkedIn: true, refunded: false }),
    );
    expect(html).toContain('<span class="badge">Checked in</span>');
    expect(html).not.toContain("Refunded");
  });

  test("renders a danger badge when refunded", () => {
    const html = String(
      BookingStatusBadges({ checkedIn: false, refunded: true }),
    );
    expect(html).toContain('<span class="badge danger">Refunded</span>');
    expect(html).not.toContain("Checked in");
  });

  test("renders both badges when checked in and refunded", () => {
    const html = String(
      BookingStatusBadges({ checkedIn: true, refunded: true }),
    );
    expect(html).toContain("Checked in");
    expect(html).toContain("Refunded");
  });
});

describe("AttendeeBookingsTable", () => {
  test("returns null when the attendee has no bookings", () => {
    // Null lets the caller drop the whole section.
    expect(AttendeeBookingsTable({ bookings: [] })).toBeNull();
  });

  test("lists each booked listing with a link, quantity, and total", () => {
    const html = renderBookings([
      booking({ listingId: 7, listingName: "Kayak", quantity: 2 }),
      booking({ listingId: 8, listingName: "Canoe", quantity: 3 }),
    ]);
    expect(html).toContain("Bookings");
    expect(html).toContain('href="/admin/listing/7"');
    expect(html).toContain("Kayak");
    expect(html).toContain('href="/admin/listing/8"');
    expect(html).toContain("Canoe");
    // The footer totals the quantities (2 + 3); only the total cell holds 5.
    expect(html).toContain("Total");
    expect(html).toContain("<td>5</td>");
  });

  test("formats the date range for a dated (daily) booking", () => {
    const html = renderBookings([
      booking({
        endAt: "2026-06-03T00:00:00Z",
        startAt: "2026-06-01T00:00:00Z",
      }),
    ]);
    expect(html).toContain(
      formatDateRangeLabel("2026-06-01T00:00:00Z", "2026-06-03T00:00:00Z"),
    );
  });

  test("shows an em dash in the date cell when a booking has no date", () => {
    // A standard (fixed-date) booking carries no start date; the status badge
    // proves the only em dash present is the date fallback.
    const html = renderBookings([booking({ checkedIn: true, startAt: null })]);
    expect(html).toContain("Checked in");
    expect(html).toContain("—");
  });

  test("marks an inactive listing", () => {
    expect(renderBookings([booking({ listingActive: false })])).toContain(
      "(Inactive)",
    );
    expect(renderBookings([booking({ listingActive: true })])).not.toContain(
      "(Inactive)",
    );
  });

  test("falls back to an em dash when a booking has no status", () => {
    // Dated so the only em dash can come from the empty status cell.
    const html = renderBookings([
      booking({
        checkedIn: false,
        endAt: "2026-06-02T00:00:00Z",
        refunded: false,
        startAt: "2026-06-01T00:00:00Z",
      }),
    ]);
    expect(html).not.toContain("Checked in");
    expect(html).not.toContain("Refunded");
    expect(html).toContain("—");
  });
});

describe("AttendeeAnswersTable", () => {
  const questions: QuestionWithAnswers[] = [
    {
      answers: [
        { active: true, id: 10, question_id: 1, sort_order: 0, text: "Small" },
        { active: true, id: 11, question_id: 1, sort_order: 1, text: "Large" },
      ],
      display_type: "radio" as const,
      id: 1,
      text: "Shirt size?",
    },
    {
      answers: [
        { active: true, id: 20, question_id: 2, sort_order: 0, text: "Vegan" },
      ],
      display_type: "radio" as const,
      id: 2,
      text: "Meal?",
    },
  ];

  test("lists only the questions the attendee answered", () => {
    const html = String(
      AttendeeAnswersTable({ questions, selectedAnswerIds: [11] }),
    );
    expect(html).toContain("Answers");
    expect(html).toContain("Shirt size?");
    expect(html).toContain("Large");
    // Unanswered question and the unpicked option are absent.
    expect(html).not.toContain("Meal?");
    expect(html).not.toContain("Small");
  });

  test("returns null when the attendee answered no questions", () => {
    // Null lets the caller drop the section entirely (JSX renders it as empty).
    expect(
      AttendeeAnswersTable({ questions, selectedAnswerIds: [] }),
    ).toBeNull();
  });
});

describe("AttendeeLogSection", () => {
  const entries: ActivityLogEntry[] = [
    {
      attendee_id: 7,
      created: "2026-01-15T10:30:00Z",
      id: 1,
      listing_id: 2,
      message: "Attendee 'Jane Doe' updated",
    },
  ];

  test("renders a collapsed details disclosure with the log table", () => {
    const html = String(AttendeeLogSection({ entries }));
    expect(html).toContain("<details>");
    // Collapsed by default — no open attribute.
    expect(html).not.toContain("<details open");
    expect(html).toContain("<summary>Activity Log</summary>");
    expect(html).toContain("Attendee 'Jane Doe' updated");
    // Same Time/Activity columns as /admin/log.
    expect(html).toContain("<th>Time</th>");
    expect(html).toContain("<th>Activity</th>");
  });

  test("shows the empty state when the attendee has no log entries", () => {
    const html = String(AttendeeLogSection({ entries: [] }));
    expect(html).toContain("No activity recorded yet");
  });
});
