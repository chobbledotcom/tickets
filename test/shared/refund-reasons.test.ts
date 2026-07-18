import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ErrorCode } from "#shared/logger.ts";
import {
  type RefundCode,
  RefundCodeSchema,
  storedCheckoutRefund,
} from "#shared/refund-reasons.ts";

const REFUND_CODES: RefundCode[] = [
  "capacity_full",
  "charge_mismatch",
  "listing_removed",
  "price_changed",
  "sold_out",
  "unexpected_error",
];

describe("refund reasons", () => {
  test("accepts every stored refund code", () => {
    expect(REFUND_CODES.map((code) => v.parse(RefundCodeSchema, code))).toEqual(
      REFUND_CODES,
    );
  });

  test("stores stable fields without the notification", () => {
    expect(
      storedCheckoutRefund({
        code: "unexpected_error",
        detail: "Provider failed",
        notify: ErrorCode.PAYMENT_SESSION,
        reason: "Payment could not be refunded",
      }),
    ).toEqual({
      code: "unexpected_error",
      detail: "Provider failed",
      reason: "Payment could not be refunded",
    });
  });
});
