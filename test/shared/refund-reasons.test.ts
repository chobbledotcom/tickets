import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ErrorCode } from "#shared/logger.ts";
import {
  type RefundCode,
  RefundCodeSchema,
  StoredCheckoutRefundSchema,
  storedCheckoutRefund,
} from "#shared/refund-reasons.ts";

const REFUND_CODES: RefundCode[] = [
  "capacity_full",
  "charge_mismatch",
  "listing_removed",
  "price_changed",
  "registration_closed",
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
      }),
    ).toEqual({
      code: "unexpected_error",
      detail: "Provider failed",
    });
  });

  test("ignores the unused reason field in an older stored refund", () => {
    expect(
      v.parse(StoredCheckoutRefundSchema, {
        code: "capacity_full",
        detail: "Event filled",
        reason: "old operator phrase",
      }),
    ).toEqual({ code: "capacity_full", detail: "Event filled" });
  });
});
