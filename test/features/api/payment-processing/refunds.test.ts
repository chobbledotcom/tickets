import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  chargeMismatchSpec,
  deletedListingSpec,
  refundedNoteText,
  refundSpec,
  validationFailure,
} from "#routes/api/payment-processing/refunds.ts";
import { ErrorCode } from "#shared/logger.ts";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";

const session = (
  values: Partial<ValidatedPaymentSession> = {},
): ValidatedPaymentSession => ({
  amountTotal: 5000,
  id: "cs_1",
  metadata: {} as SessionMetadata,
  paymentReference: "pi_1",
  paymentStatus: "paid",
  ...values,
});

describe("why a booking we kept had to be refunded", () => {
  test("names the reason the operator reads and the log line the caller gave", () => {
    expect(refundSpec("capacity_full")("listing=1 wanted=3 left=1")).toEqual({
      code: "capacity_full",
      detail: "listing=1 wanted=3 left=1",
      reason: "the event filled up while they were paying",
    });
  });

  // A full event or a sold-out extra is ordinary; a wrong charge, a vanished
  // listing, or an unexpected error is a broken promise somebody should see.
  for (const [code, notify] of [
    ["capacity_full", undefined],
    ["sold_out", undefined],
    ["price_changed", undefined],
    ["charge_mismatch", ErrorCode.WEBHOOK_PRICE_SIGNATURE],
    ["listing_removed", ErrorCode.PAYMENT_SESSION],
    ["unexpected_error", ErrorCode.PAYMENT_SESSION],
  ] as const) {
    test(`${notify === undefined ? "does not page" : "pages"} anyone about ${code}`, () => {
      expect(refundSpec(code)("detail").notify).toBe(notify);
    });
  }

  test("a wrong charge records both figures without naming the buyer", () => {
    const spec = chargeMismatchSpec(session({ amountTotal: 5500 }), 5000);

    expect(spec.code).toBe("charge_mismatch");
    expect(spec.detail).toBe("Provider charged 5500 but signed total was 5000");
  });

  test("a listing that vanished mid-payment records the checkout it was for", () => {
    const spec = deletedListingSpec(session({ id: "cs_gone" }));

    expect(spec.code).toBe("listing_removed");
    expect(spec.detail).toContain("cs_gone");
  });
});

describe("the note left on a booking that was kept but refunded", () => {
  const spec = refundSpec("sold_out")("listing=4");

  test("says the money went back, and where to check", () => {
    const note = refundedNoteText(7, spec, true, "pi_abc");

    expect(note).toContain("its payment was refunded because");
    expect(note).toContain("an add-on or extra they chose sold out");
    expect(note).toContain("Payment reference: pi_abc (code: sold_out).");
    expect(note).toContain("[ledger](/admin/ledger/attendee/7)");
  });

  test("says plainly when the money did NOT go back, and asks for a hand", () => {
    const note = refundedNoteText(7, spec, false, "pi_abc");

    expect(note).toContain("could NOT be refunded automatically");
    expect(note).toContain("Please refund it manually");
  });

  test("never carries the buyer's name or email", () => {
    // The note is read by an operator in a list; the provider's reference is
    // what ties it back to the charge, so no personal details are needed.
    const note = refundedNoteText(7, spec, true, "pi_abc");

    expect(note).not.toContain("@");
  });
});

describe("a checkout whose listing did not check out", () => {
  test("does not refund when the listing is unknown to this site", () => {
    // The webhook may belong to another site sharing the provider account, so
    // refunding here would give back money this site never took.
    const result = validationFailure(
      session(),
      { error: "Listing not found", status: 404 },
      1,
    );

    expect(result).toEqual({
      detail: "Post-payment listing not found (session=cs_1)",
      error: "Listing not found",
      status: 404,
      success: false,
    });
  });
});
