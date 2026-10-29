import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isPaymentLockedLine,
  parseAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import { attendeeBalanceNotice } from "#routes/admin/attendee-form-validation.ts";
import {
  line,
  makeForm,
} from "#test/features/admin/attendee-form-model/fixtures.ts";
import { bookingRow } from "#test-utils/factories.ts";

describe("attendee form model > boundaries", () => {
  test("one penny paid locks a line", () => {
    expect(
      isPaymentLockedLine(
        line({ existingBooking: bookingRow({ price_paid: 1 }) }),
      ),
    ).toBe(true);
  });

  test("reads the return link and a status id of 1", () => {
    const parsed = parseAttendeeForm(
      makeForm({ name: "X", return_url: "/admin/calendar", status_id: "1" }),
      new Map(),
    );
    expect(parsed.returnUrl).toBe("/admin/calendar");
    expect(parsed.statusId).toBe(1);
  });

  describe("a balance of one penny", () => {
    const paid = { is_paid_default: true, is_reservation: false };
    const reservation = { is_paid_default: false, is_reservation: true };

    test("still warns on a paid status", () => {
      expect(attendeeBalanceNotice(paid, 1, 1000, 999)?.tone).toBe("warning");
    });

    test("keeps a reservation quiet", () => {
      expect(attendeeBalanceNotice(reservation, 1, 1000, 999)).toBeNull();
    });

    test("still owed on a reservation warns", () => {
      expect(attendeeBalanceNotice(reservation, 0, 1000, 999)?.tone).toBe(
        "warning",
      );
    });

    test("paid in full on a reservation nudges", () => {
      expect(attendeeBalanceNotice(reservation, 0, 1, 1)?.tone).toBe("info");
    });
  });
});
