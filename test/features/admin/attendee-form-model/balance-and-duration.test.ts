import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeBalanceNotice,
  bookingDurationDays,
} from "#routes/admin/attendee-form-model.ts";
import { testBookingRow } from "#test-utils/attendees/helpers.ts";

describe("bookingDurationDays", () => {
  test("returns null when a range endpoint is missing or invalid", () => {
    expect(
      bookingDurationDays(testBookingRow({ end_at: "x", start_at: null })),
    ).toBeNull();
    expect(
      bookingDurationDays(testBookingRow({ end_at: null, start_at: "x" })),
    ).toBeNull();
    expect(
      bookingDurationDays(testBookingRow({ end_at: "bad", start_at: "bad" })),
    ).toBeNull();
  });

  test("returns null for a zero-length range", () => {
    expect(
      bookingDurationDays(
        testBookingRow({
          end_at: "2026-06-14T00:00:00Z",
          start_at: "2026-06-14T00:00:00Z",
        }),
      ),
    ).toBeNull();
  });

  test("counts whole days for a real range", () => {
    expect(
      bookingDurationDays(
        testBookingRow({
          end_at: "2026-06-17T00:00:00Z",
          start_at: "2026-06-14T00:00:00Z",
        }),
      ),
    ).toBe(3);
  });
});
describe("attendeeBalanceNotice", () => {
  const paid = { is_paid_default: true, is_reservation: false };
  const reservation = { is_paid_default: false, is_reservation: true };
  const other = { is_paid_default: false, is_reservation: false };

  test("is silent when there is no status", () => {
    expect(attendeeBalanceNotice(null, 500, 1000, 100)).toBeNull();
  });

  test("warns when a paid status still owes money", () => {
    const notice = attendeeBalanceNotice(paid, 500, 1000, 500);
    expect(notice?.tone).toBe("warning");
    expect(notice?.message).toContain("paid status");
  });

  test("is silent when a paid status owes nothing", () => {
    expect(attendeeBalanceNotice(paid, 0, 1000, 1000)).toBeNull();
  });

  test("is silent for a reservation that still owes a balance", () => {
    expect(attendeeBalanceNotice(reservation, 900, 1000, 100)).toBeNull();
  });

  test("warns when a reservation has no balance but is still unpaid", () => {
    const notice = attendeeBalanceNotice(reservation, 0, 1000, 100);
    expect(notice?.tone).toBe("warning");
    expect(notice?.message).toContain("still unpaid");
  });

  test("nudges (info) when a reservation is fully paid", () => {
    const notice = attendeeBalanceNotice(reservation, 0, 1000, 1000);
    expect(notice?.tone).toBe("info");
    expect(notice?.message).toContain("moving it to a paid status");
  });

  test("is silent for a free reservation with no balance", () => {
    expect(attendeeBalanceNotice(reservation, 0, 0, 0)).toBeNull();
  });

  test("is silent for a balance on a neither-paid-nor-reservation status", () => {
    expect(attendeeBalanceNotice(other, 500, 1000, 500)).toBeNull();
  });

  test("warns when a paid status owes a single unit", () => {
    const notice = attendeeBalanceNotice(paid, 1, 1000, 999);
    expect(notice?.tone).toBe("warning");
  });

  test("stays silent for a reservation that owes a single unit of balance", () => {
    expect(attendeeBalanceNotice(reservation, 1, 1000, 0)).toBeNull();
  });

  test("warns when a reservation is unpaid by a single unit", () => {
    const notice = attendeeBalanceNotice(reservation, 0, 1, 0);
    expect(notice?.tone).toBe("warning");
  });

  test("nudges (info) when a single-unit reservation is fully paid", () => {
    const notice = attendeeBalanceNotice(reservation, 0, 1, 1);
    expect(notice?.tone).toBe("info");
  });
});
