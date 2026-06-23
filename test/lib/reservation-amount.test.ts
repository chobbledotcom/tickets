import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  allocateReservationDeposit,
  computeReservationDeposit,
  parseReservationAmount,
  RESERVATION_AMOUNT_HINT,
  validateReservationAmount,
} from "#shared/reservation-amount.ts";
import { testWithSetting } from "#test-utils";

describe("reservation-amount", () => {
  describe("parseReservationAmount", () => {
    test("parses a flat currency amount", () => {
      expect(parseReservationAmount("10")).toEqual({ kind: "flat", value: 10 });
    });

    test("parses zero as flat", () => {
      expect(parseReservationAmount("0")).toEqual({ kind: "flat", value: 0 });
    });

    test("parses a percentage", () => {
      expect(parseReservationAmount("10%")).toEqual({
        kind: "percent",
        value: 10,
      });
    });

    test("parses a per-item amount", () => {
      expect(parseReservationAmount("10x")).toEqual({
        kind: "perItem",
        value: 10,
      });
    });

    test("parses decimal values", () => {
      expect(parseReservationAmount("33.33%")).toEqual({
        kind: "percent",
        value: 33.33,
      });
      expect(parseReservationAmount("10.50")).toEqual({
        kind: "flat",
        value: 10.5,
      });
    });

    test("trims surrounding whitespace", () => {
      expect(parseReservationAmount("  25%  ")).toEqual({
        kind: "percent",
        value: 25,
      });
    });

    test("rejects malformed input", () => {
      const malformed = [
        "",
        "abc",
        "-5",
        "10 %",
        "10%x",
        "x",
        "%",
        "10.",
        ".5",
        "1e3",
      ];
      for (const raw of malformed) {
        expect(parseReservationAmount(raw)).toBeNull();
      }
    });
  });

  describe("validateReservationAmount", () => {
    test("returns null for valid input", () => {
      expect(validateReservationAmount("10%")).toBeNull();
      expect(validateReservationAmount("0")).toBeNull();
    });

    test("returns the hint for invalid input", () => {
      expect(validateReservationAmount("")).toBe(RESERVATION_AMOUNT_HINT);
      expect(validateReservationAmount("nope")).toBe(RESERVATION_AMOUNT_HINT);
    });
  });

  describe("computeReservationDeposit", () => {
    // Full order: £100.00 (10000 minor units), 4 items.
    testWithSetting("percentage of the full price", { currency: "GBP" }, () => {
      expect(computeReservationDeposit("10%", 10000, 4)).toBe(1000);
    });

    testWithSetting(
      "rounds percentage to the nearest unit",
      {
        currency: "GBP",
      },
      () => {
        // 33.33% of 10000 = 3333
        expect(computeReservationDeposit("33.33%", 10000, 1)).toBe(3333);
      },
    );

    testWithSetting(
      "flat amount converts currency units to minor units",
      {
        currency: "GBP",
      },
      () => {
        // "10" → £10.00 → 1000 minor units, regardless of quantity
        expect(computeReservationDeposit("10", 10000, 4)).toBe(1000);
      },
    );

    testWithSetting(
      "per-item amount multiplies by quantity",
      {
        currency: "GBP",
      },
      () => {
        // "10x" → £10.00 per item × 4 = 4000 minor units
        expect(computeReservationDeposit("10x", 10000, 4)).toBe(4000);
      },
    );

    testWithSetting("zero yields no deposit", { currency: "GBP" }, () => {
      expect(computeReservationDeposit("0", 10000, 4)).toBe(0);
    });

    testWithSetting(
      "clamps a deposit above the full price",
      {
        currency: "GBP",
      },
      () => {
        // 150% would be 15000, clamped to the 10000 full price
        expect(computeReservationDeposit("150%", 10000, 1)).toBe(10000);
        // "20x" × 4 = 8000... still under; use a flat that overshoots
        expect(computeReservationDeposit("200", 10000, 1)).toBe(10000);
      },
    );

    testWithSetting(
      "honours currencies with no minor units (JPY)",
      {
        currency: "JPY",
      },
      () => {
        // ¥10 flat = 10 minor units (JPY has 0 decimal places)
        expect(computeReservationDeposit("10", 10000, 3)).toBe(10);
        expect(computeReservationDeposit("10x", 10000, 3)).toBe(30);
      },
    );

    testWithSetting(
      "malformed amount yields a zero deposit",
      {
        currency: "GBP",
      },
      () => {
        expect(computeReservationDeposit("nonsense", 10000, 4)).toBe(0);
      },
    );
  });

  describe("allocateReservationDeposit", () => {
    testWithSetting(
      "returns no allocation when there are no items",
      {
        currency: "GBP",
      },
      () => {
        const allocation = allocateReservationDeposit("10", []);
        expect(allocation).toEqual({ lines: [], perItemTotals: [], total: 0 });
      },
    );

    testWithSetting(
      "flat 10 across 3 equal tickets allocates exactly 1000 minor units",
      { currency: "GBP" },
      () => {
        const allocation = allocateReservationDeposit("10", [
          { quantity: 3, unitPrice: 1000 },
        ]);
        expect(allocation.total).toBe(1000);
        expect(allocation.perItemTotals).toEqual([1000]);
        expect(allocation.lines).toEqual([
          { chargedUnitAmount: 334, itemIndex: 0, quantity: 1 },
          { chargedUnitAmount: 333, itemIndex: 0, quantity: 2 },
        ]);
      },
    );

    testWithSetting(
      "flat 10.01 across 3 equal tickets allocates exactly 1001 minor units",
      { currency: "GBP" },
      () => {
        const allocation = allocateReservationDeposit("10.01", [
          { quantity: 3, unitPrice: 1000 },
        ]);
        expect(allocation.total).toBe(1001);
        expect(allocation.perItemTotals).toEqual([1001]);
        expect(allocation.lines).toEqual([
          { chargedUnitAmount: 334, itemIndex: 0, quantity: 2 },
          { chargedUnitAmount: 333, itemIndex: 0, quantity: 1 },
        ]);
      },
    );

    testWithSetting(
      "flat deposit larger than the order clamps to the full order total",
      { currency: "GBP" },
      () => {
        const allocation = allocateReservationDeposit("100", [
          { quantity: 2, unitPrice: 300 },
        ]);
        expect(allocation.total).toBe(600);
        expect(allocation.perItemTotals).toEqual([600]);
        expect(allocation.lines).toEqual([
          { chargedUnitAmount: 300, itemIndex: 0, quantity: 2 },
        ]);
      },
    );

    testWithSetting(
      "mixed quantities and prices allocate exactly without exceeding unit prices",
      { currency: "GBP" },
      () => {
        const allocation = allocateReservationDeposit("10", [
          { quantity: 2, unitPrice: 1000 },
          { quantity: 1, unitPrice: 2500 },
          { quantity: 3, unitPrice: 500 },
        ]);
        expect(allocation.total).toBe(1000);
        expect(allocation.perItemTotals).toEqual([334, 417, 249]);
        expect(allocation.lines).toEqual([
          { chargedUnitAmount: 167, itemIndex: 0, quantity: 2 },
          { chargedUnitAmount: 417, itemIndex: 1, quantity: 1 },
          { chargedUnitAmount: 83, itemIndex: 2, quantity: 3 },
        ]);
        for (const line of allocation.lines) {
          const item = [
            { quantity: 2, unitPrice: 1000 },
            { quantity: 1, unitPrice: 2500 },
            { quantity: 3, unitPrice: 500 },
          ][line.itemIndex]!;
          expect(line.chargedUnitAmount).toBeLessThanOrEqual(item.unitPrice);
        }
      },
    );

    testWithSetting(
      "breaks leftover ties by cart order across items, not by item alone",
      { currency: "GBP" },
      () => {
        // Deposit of 20 minor units across 4 units priced [90, 70, 70, 70]
        // (item0 ×1, item1 ×2, item2 ×1; subtotal 300). Proportional floors are
        // [6, 4, 4, 4] (18) leaving 2 leftover minor units. The three 70-priced
        // units share the same fractional remainder, so the two leftovers must
        // go to the *earliest* units in cart order — both of item1's units —
        // never to item2's later unit. This pins down that each unit's tie-break
        // key is its absolute cart position (prefix quantity + unit index), so
        // item1's second unit outranks item2's first unit.
        const allocation = allocateReservationDeposit("0.20", [
          { quantity: 1, unitPrice: 90 },
          { quantity: 2, unitPrice: 70 },
          { quantity: 1, unitPrice: 70 },
        ]);
        expect(allocation.total).toBe(20);
        expect(allocation.perItemTotals).toEqual([6, 10, 4]);
        expect(allocation.lines).toEqual([
          { chargedUnitAmount: 6, itemIndex: 0, quantity: 1 },
          { chargedUnitAmount: 5, itemIndex: 1, quantity: 2 },
          { chargedUnitAmount: 4, itemIndex: 2, quantity: 1 },
        ]);
      },
    );

    testWithSetting(
      "percent and per-item totals preserve their order-level semantics",
      { currency: "GBP" },
      () => {
        expect(
          allocateReservationDeposit("10%", [{ quantity: 2, unitPrice: 1000 }])
            .total,
        ).toBe(200);
        expect(
          allocateReservationDeposit("10x", [{ quantity: 2, unitPrice: 1000 }])
            .total,
        ).toBe(2000);
      },
    );
  });
});
