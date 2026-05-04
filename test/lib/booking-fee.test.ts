import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  calculateBookingFee,
  getBookingFeeAmount,
  itemsSubtotal,
} from "#shared/booking-fee.ts";
import { testWithSetting } from "#test-utils";

describe("calculateBookingFee", () => {
  test("applies the fee percentage to the subtotal", () => {
    expect(calculateBookingFee(1000, 2.9)).toBe(29);
  });

  test("rounds fractional results to the nearest minor unit", () => {
    // 999 × 1.5% = 14.985 → 15; 100 × 2.5% = 2.5 → 3 (half rounds up).
    // Fees must land on whole minor units so Stripe/Square accept the charge.
    expect(calculateBookingFee(999, 1.5)).toBe(15);
    expect(calculateBookingFee(100, 2.5)).toBe(3);
  });

  test("charges no fee when the percent is zero or negative", () => {
    expect(calculateBookingFee(1000, 0)).toBe(0);
    expect(calculateBookingFee(1000, -1)).toBe(0);
  });
});

describe("getBookingFeeAmount", () => {
  testWithSetting(
    "returns 0 when no booking fee is configured",
    { booking_fee: "0" },
    () => {
      expect(getBookingFeeAmount(10000)).toBe(0);
    },
  );

  testWithSetting(
    "applies the configured fee to the supplied subtotal",
    { booking_fee: "2.5" },
    () => {
      expect(getBookingFeeAmount(10000)).toBe(250);
    },
  );

  testWithSetting(
    "treats an empty fee setting as no fee",
    { booking_fee: "" },
    () => {
      // Admins can blank the field to disable the booking fee; the guard
      // must stop the empty string turning into NaN and poisoning cart totals.
      expect(getBookingFeeAmount(10000)).toBe(0);
    },
  );

  testWithSetting(
    "treats a non-numeric fee setting as no fee",
    { booking_fee: "not a number" },
    () => {
      // parseFloat returns NaN for garbage input — the `|| 0` guard in
      // getBookingFee() must prevent NaN ever reaching the payment provider.
      expect(getBookingFeeAmount(10000)).toBe(0);
    },
  );
});

describe("itemsSubtotal", () => {
  test("returns 0 for an empty cart", () => {
    expect(itemsSubtotal([])).toBe(0);
  });

  test("sums unitPrice × quantity across mixed items", () => {
    expect(
      itemsSubtotal([
        { quantity: 3, unitPrice: 500 },
        { quantity: 1, unitPrice: 250 },
        { quantity: 2, unitPrice: 1000 },
      ]),
    ).toBe(3750);
  });

  test("counts free (zero-priced) items as contributing nothing", () => {
    // Free tickets alongside paid ones must not inflate the subtotal, which
    // would otherwise push up the percentage-based booking fee.
    expect(
      itemsSubtotal([
        { quantity: 5, unitPrice: 0 },
        { quantity: 1, unitPrice: 750 },
      ]),
    ).toBe(750);
  });
});
