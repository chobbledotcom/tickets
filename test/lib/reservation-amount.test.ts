import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  computeReservationDeposit,
  parseReservationAmount,
  RESERVATION_AMOUNT_HINT,
  reservationDepositPerUnit,
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

  describe("reservationDepositPerUnit", () => {
    // Per-unit deposit: the amount one ticket is charged up front.
    testWithSetting("percent of the unit price", { currency: "GBP" }, () => {
      // 10% of a £10.00 ticket = £1.00.
      expect(reservationDepositPerUnit("10%", 1000, 4)).toBe(100);
    });

    testWithSetting(
      "per-item is a flat amount per unit",
      { currency: "GBP" },
      () => {
        // "10x" → £10.00 per ticket, independent of how many were booked.
        expect(reservationDepositPerUnit("10x", 5000, 4)).toBe(1000);
      },
    );

    testWithSetting(
      "flat spreads the order amount across all units",
      { currency: "GBP" },
      () => {
        // "20" → £20.00 over 4 tickets = £5.00 each.
        expect(reservationDepositPerUnit("20", 5000, 4)).toBe(500);
      },
    );

    testWithSetting(
      "flat treats a zero total quantity as one unit",
      { currency: "GBP" },
      () => {
        // Guards against division by zero: the whole amount lands on one unit.
        expect(reservationDepositPerUnit("20", 5000, 0)).toBe(2000);
      },
    );

    testWithSetting(
      "clamps the per-unit deposit to the unit price",
      { currency: "GBP" },
      () => {
        expect(reservationDepositPerUnit("150%", 1000, 1)).toBe(1000);
        expect(reservationDepositPerUnit("100x", 1000, 1)).toBe(1000);
      },
    );

    testWithSetting("malformed amount yields zero", { currency: "GBP" }, () => {
      expect(reservationDepositPerUnit("nope", 1000, 1)).toBe(0);
    });
  });
});
