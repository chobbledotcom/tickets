import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isIncompletePayment } from "#shared/incomplete-payment.ts";
import { completePaymentAttendees } from "#templates/admin/listings/attendees.tsx";
import { getListingForm } from "#templates/fields/listing.ts";
import { registerListingTemplateHooks } from "#test/ui/templates/admin/listings/helpers.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

describe("isIncompletePayment", () => {
  registerListingTemplateHooks();

  test("returns true for paid listing attendee with no payment_id and price > 0", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "1000" });
    expect(isIncompletePayment(attendee, true, false)).toBe(true);
  });

  test("returns false for free listing", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "0" });
    expect(isIncompletePayment(attendee, false, false)).toBe(false);
  });

  test("returns false for admin-added attendee on paid listing (price_paid=0)", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "0" });
    expect(isIncompletePayment(attendee, true, false)).toBe(false);
  });

  test("returns false for completed payment attendee", () => {
    const attendee = testAttendee({
      payment_id: "pi_test_123",
      price_paid: "1000",
    });
    expect(isIncompletePayment(attendee, true, true)).toBe(false);
  });

  test("returns false when an empty-payment-id attendee has a processed reference", () => {
    const attendee = testAttendee({ payment_id: "", price_paid: "1000" });
    expect(isIncompletePayment(attendee, true, true)).toBe(false);
  });

  test("returns false for refunded paid attendee with no surviving payment reference", () => {
    const attendee = testAttendee({
      payment_id: "",
      price_paid: "1000",
      refunded: true,
    });
    expect(isIncompletePayment(attendee, true, false)).toBe(false);
  });

  test("returns true for a one-unit paid attendee with no payment reference", () => {
    // Probes the boundary of `price_paid > 0`: distinguish > 0 from > 1.
    const attendee = testAttendee({ payment_id: "", price_paid: "1" });
    expect(isIncompletePayment(attendee, true, false)).toBe(true);
  });

  test("returns false when the attendee still owes money", () => {
    // Probes the boundary of `remaining_balance <= 0`: distinguish <= 0 from
    // <= 1. Someone who paid part but still owes is not an incomplete payment.
    const attendee = testAttendee({
      payment_id: "",
      price_paid: "1000",
      remaining_balance: 1,
    });
    expect(isIncompletePayment(attendee, true, false)).toBe(false);
  });
});

describe("completePaymentAttendees", () => {
  registerListingTemplateHooks();

  test("drops unresolved-payment rows on a paid listing", () => {
    const listing = testListingWithCount({ unit_price: 1000 });
    const paid = testAttendee({
      id: 1,
      payment_id: "pi_ok",
      price_paid: "1000",
    });
    const failed = testAttendee({ id: 2, payment_id: "", price_paid: "1000" });
    expect(completePaymentAttendees(listing, [paid, failed])).toEqual([paid]);
  });

  test("keeps an empty-payment-id attendee with a processed reference", () => {
    const listing = testListingWithCount({ unit_price: 1000 });
    const balancePaid = testAttendee({
      id: 2,
      payment_id: "",
      price_paid: "1000",
    });
    expect(
      completePaymentAttendees(listing, [balancePaid], new Set([2])),
    ).toEqual([balancePaid]);
  });

  test("keeps every row on a free listing", () => {
    const listing = testListingWithCount({ unit_price: 0 });
    const a = testAttendee({ id: 1, payment_id: "", price_paid: "0" });
    const b = testAttendee({ id: 2, payment_id: "", price_paid: "1000" });
    expect(completePaymentAttendees(listing, [a, b])).toEqual([a, b]);
  });
});

describe("datetime validation via listing form date field", () => {
  registerListingTemplateHooks();

  const dateField = getListingForm().fields.find((f) => f.name === "date")!;

  test("accepts valid datetime value", () => {
    const result = dateField.validate?.("2026-06-15T14:00");
    expect(result).toBeNull();
  });

  test("rejects invalid datetime value", () => {
    const result = dateField.validate?.("not-a-date");
    expect(result).toBe("Please enter a valid date and time");
  });
});
