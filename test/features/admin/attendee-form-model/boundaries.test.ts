import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE_FORM_ID,
  attendeeBalanceNotice,
  isPaymentLockedLine,
  parseAttendeeForm,
  toLedgerOrder,
} from "#routes/admin/attendee-form-model.ts";
import {
  line,
  makeForm,
  parsedBase,
} from "#test/features/admin/attendee-form-model/fixtures.ts";
import { bookingRow, testListingWithCount } from "#test-utils/factories.ts";

describe("attendee form model > boundaries", () => {
  test("the form id is the one the stylesheet styles", async () => {
    const stylesheet = await Deno.readTextFile("src/ui/static/style.scss");
    expect(ATTENDEE_FORM_ID).toBe("attendee-form");
    expect(stylesheet).toContain(`#${ATTENDEE_FORM_ID} `);
  });

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

  test("a ledger order prices each booked line and totals nothing", () => {
    const listing = testListingWithCount({
      id: 4,
      name: "Gala",
      slug: "gala",
      unit_price: 1200,
    });
    const order = toLedgerOrder(
      parsedBase({
        lines: [
          line({ listing, listingId: 4, quantity: 2 }),
          line({ listing, listingId: 4, packagePrice: 0, quantity: 1 }),
          line({ listing, listingId: 4, quantity: 0 }),
        ],
      }),
    );
    expect(order).toEqual({
      extras: [],
      fullSubtotal: 0,
      lines: [
        {
          chargedUnitAmount: 1200,
          item: {
            listingId: 4,
            name: "Gala",
            quantity: 2,
            slug: "gala",
            unitPrice: 1200,
          },
          quantity: 2,
        },
        {
          chargedUnitAmount: 0,
          item: {
            listingId: 4,
            name: "Gala",
            quantity: 1,
            slug: "gala",
            unitPrice: 0,
          },
          quantity: 1,
        },
      ],
      modifierApplications: [],
      total: 0,
    });
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
