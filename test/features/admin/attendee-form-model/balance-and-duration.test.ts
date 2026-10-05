import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeBalanceNotice,
  bookingDurationDays,
} from "#routes/admin/attendee-form-model.ts";
import { bookingRow } from "#test-utils/factories.ts";

describe("bookingDurationDays", () => {
  test("returns null when a range endpoint is missing or invalid", () => {
    expect(
      bookingDurationDays(bookingRow({ end_at: "x", start_at: null })),
    ).toBeNull();
    expect(
      bookingDurationDays(bookingRow({ end_at: null, start_at: "x" })),
    ).toBeNull();
    expect(
      bookingDurationDays(bookingRow({ end_at: "bad", start_at: "bad" })),
    ).toBeNull();
  });

  test("returns null for a zero-length range", () => {
    expect(
      bookingDurationDays(
        bookingRow({
          end_at: "2026-06-14T00:00:00Z",
          start_at: "2026-06-14T00:00:00Z",
        }),
      ),
    ).toBeNull();
  });

  test("counts whole days for a real range", () => {
    expect(
      bookingDurationDays(
        bookingRow({
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
    expect(attendeeBalanceNotice(paid, 500, 1000, 500)).toEqual({
      message: "This attendee is in a paid status but still owes £5.",
      tone: "warning",
    });
  });

  test("is silent when a paid status owes nothing", () => {
    expect(attendeeBalanceNotice(paid, 0, 1000, 1000)).toBeNull();
  });

  test("is silent for a reservation that still owes a balance", () => {
    expect(attendeeBalanceNotice(reservation, 900, 1000, 100)).toBeNull();
    expect(attendeeBalanceNotice(reservation, 300, 1000, 700)).toBeNull();
  });

  test("warns when a reservation has no balance but is still unpaid", () => {
    expect(attendeeBalanceNotice(reservation, 0, 1000, 400)).toEqual({
      message:
        "This reservation has no balance recorded, but £6 of the order is still unpaid.",
      tone: "warning",
    });
  });

  test("nudges (info) when a reservation is fully paid", () => {
    expect(attendeeBalanceNotice(reservation, 0, 1000, 1000)).toEqual({
      message:
        "This reservation is fully paid — consider moving it to a paid status.",
      tone: "info",
    });
  });

  test("is silent for a free reservation with no balance", () => {
    expect(attendeeBalanceNotice(reservation, 0, 0, 0)).toBeNull();
  });

  test("is silent for a balance on a neither-paid-nor-reservation status", () => {
    expect(attendeeBalanceNotice(other, 500, 1000, 500)).toBeNull();
  });

  test("warns when a paid status owes a single unit", () => {
    expect(attendeeBalanceNotice(paid, 1, 1000, 999)).toEqual({
      message: "This attendee is in a paid status but still owes £0.01.",
      tone: "warning",
    });
  });

  test("stays silent for a reservation that owes a single unit of balance", () => {
    expect(attendeeBalanceNotice(reservation, 1, 1000, 0)).toBeNull();
  });

  test("warns when a reservation is unpaid by a single unit", () => {
    expect(attendeeBalanceNotice(reservation, 0, 1, 0)).toEqual({
      message:
        "This reservation has no balance recorded, but £0.01 of the order is still unpaid.",
      tone: "warning",
    });
  });

  test("nudges (info) when a single-unit reservation is fully paid", () => {
    expect(attendeeBalanceNotice(reservation, 0, 1, 1)).toEqual({
      message:
        "This reservation is fully paid — consider moving it to a paid status.",
      tone: "info",
    });
  });

  test("owes the larger of the price and the listed price", () => {
    expect(attendeeBalanceNotice(reservation, 0, 1000, 1000, 1200)).toEqual({
      message:
        "This reservation has no balance recorded, but £2 of the order is still unpaid.",
      tone: "warning",
    });
  });
});
