import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  calculateBookingFee,
  getBookingFeeAmount,
  itemsSubtotal,
} from "#lib/booking-fee.ts";
import { settings } from "#lib/db/settings.ts";
import { createTestDb, resetDb } from "#test-utils";

describe("calculateBookingFee", () => {
  test("returns 0 when fee percent is 0", () => {
    expect(calculateBookingFee(1000, 0)).toBe(0);
  });

  test("returns 0 when fee percent is negative", () => {
    expect(calculateBookingFee(1000, -1)).toBe(0);
  });

  test("returns 0 when subtotal is 0", () => {
    expect(calculateBookingFee(0, 2.5)).toBe(0);
  });

  test("calculates 2.9% of 1000 correctly", () => {
    // 1000 * 2.9 / 100 = 29
    expect(calculateBookingFee(1000, 2.9)).toBe(29);
  });

  test("calculates 1.5% of 1000 correctly", () => {
    // 1000 * 1.5 / 100 = 15
    expect(calculateBookingFee(1000, 1.5)).toBe(15);
  });

  test("rounds to nearest integer", () => {
    // 999 * 1.5 / 100 = 14.985 → 15
    expect(calculateBookingFee(999, 1.5)).toBe(15);
  });

  test("rounds 0.5 up", () => {
    // 100 * 2.5 / 100 = 2.5 → 3 (Math.round rounds 0.5 up)
    expect(calculateBookingFee(100, 2.5)).toBe(3);
  });

  test("calculates 10% (maximum allowed) correctly", () => {
    expect(calculateBookingFee(5000, 10)).toBe(500);
  });

  test("handles large subtotals", () => {
    // 100000 (£1000) * 1.5 / 100 = 1500
    expect(calculateBookingFee(100000, 1.5)).toBe(1500);
  });
});

describe("getBookingFeeAmount", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
  });

  test("returns 0 when no booking fee configured", async () => {
    expect(await getBookingFeeAmount(1000)).toBe(0);
  });

  test("returns calculated fee when booking fee is set", async () => {
    await settings.bookingFee.update("2.5");
    // 1000 * 2.5 / 100 = 25
    expect(await getBookingFeeAmount(1000)).toBe(25);
  });
});

describe("itemsSubtotal", () => {
  test("returns 0 for empty array", () => {
    expect(itemsSubtotal([])).toBe(0);
  });

  test("calculates subtotal from items", () => {
    const items = [
      { unitPrice: 500, quantity: 2 },
      { unitPrice: 1000, quantity: 1 },
    ];
    expect(itemsSubtotal(items)).toBe(2000);
  });
});
