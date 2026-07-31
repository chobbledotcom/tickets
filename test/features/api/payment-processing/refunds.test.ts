import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundNotificationForCode } from "#routes/api/payment-processing/refunds.ts";
import { ErrorCode } from "#shared/logger.ts";

describe("which refunds tell the operator something went wrong", () => {
  // A refund the site expected — the event filled up, the price moved, the
  // doors closed — is ordinary business and nobody needs paging about it.
  for (const code of [
    "capacity_full",
    "price_changed",
    "registration_closed",
    "sold_out",
  ] as const) {
    test(`says nothing for a refund because ${code}`, () => {
      expect(refundNotificationForCode(code)).toBeUndefined();
    });
  }

  const alerted = [
    ["charge_mismatch", ErrorCode.WEBHOOK_PRICE_SIGNATURE],
    ["listing_removed", ErrorCode.PAYMENT_SESSION],
    ["unexpected_error", ErrorCode.PAYMENT_SESSION],
  ] as const;

  for (const [code, expected] of alerted) {
    test(`raises ${expected} for a refund because ${code}`, () => {
      expect(refundNotificationForCode(code)).toBe(expected);
    });
  }
});
