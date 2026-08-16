/** The placeholder-refund reason schema: every code carries its operator
 * wording, the alert flags sit only on the codes that page someone, and the
 * system note names the reason, the code, and the ledger link. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  placeholderRefund,
  placeholderRefundNote,
} from "#shared/payment/placeholder-refund.ts";

describe("payment > placeholder refund reasons", () => {
  test("every code carries exactly its wording and alert", () => {
    const specs = (
      [
        "capacity_full",
        "charge_mismatch",
        "listing_removed",
        "malformed_charge",
        "price_changed",
        "sold_out",
        "unexpected_error",
      ] as const
    ).map((code) => placeholderRefund(code)("d"));
    expect(specs).toEqual([
      {
        code: "capacity_full",
        detail: "d",
        reason: "the event filled up while they were paying",
      },
      {
        alert: "webhook_price_signature",
        code: "charge_mismatch",
        detail: "d",
        reason: "the amount charged did not match the agreed total",
      },
      {
        alert: "payment_session",
        code: "listing_removed",
        detail: "d",
        reason: "the listing was removed while they were paying",
      },
      {
        alert: "payment_session",
        code: "malformed_charge",
        detail: "d",
        reason:
          "the provider reported the payment in a form the site could not read",
      },
      {
        code: "price_changed",
        detail: "d",
        reason: "the listing price changed while they were paying",
      },
      {
        code: "sold_out",
        detail: "d",
        reason:
          "an add-on or extra they chose sold out while they were paying",
      },
      {
        alert: "payment_session",
        code: "unexpected_error",
        detail: "d",
        reason: "an unexpected error stopped the booking being completed",
      },
    ]);
  });

  test("a spec carries its code, wording, and detail", () => {
    expect(placeholderRefund("malformed_charge")("session cs_1 unreadable"))
      .toEqual({
        alert: "payment_session",
        code: "malformed_charge",
        detail: "session cs_1 unreadable",
        reason:
          "the provider reported the payment in a form the site could not read",
      });
    expect(placeholderRefund("price_changed")("was 500, now 600")).toEqual({
      code: "price_changed",
      detail: "was 500, now 600",
      reason: "the listing price changed while they were paying",
    });
  });

  test("the refunded note says the money went back and names the ledger", () => {
    const note = placeholderRefundNote(
      7,
      placeholderRefund("malformed_charge")("x"),
      true,
    );
    expect(note).toBe(
      "This booking was kept at quantity 0 but its payment was refunded because the provider reported the payment in a form the site could not read. Refund code: malformed_charge. Please check the [ledger](/admin/ledger/attendee/7).",
    );
  });

  test("the unrefunded note points at Refund recovery instead", () => {
    const note = placeholderRefundNote(
      9,
      placeholderRefund("sold_out")("x"),
      false,
    );
    expect(note).toBe(
      "This booking was kept at quantity 0 because an add-on or extra they chose sold out while they were paying. Its refund is tracked in Refund recovery. Refund code: sold_out. Please check the [ledger](/admin/ledger/attendee/9).",
    );
  });
});
