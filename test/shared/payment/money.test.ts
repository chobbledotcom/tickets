import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import * as v from "valibot";
import {
  CurrencySchema,
  type Money,
  MoneySchema,
  money,
} from "#shared/payment/money.ts";

describe("money", () => {
  describe("money", () => {
    // The cases that must build a charge: a non-negative whole minor-unit
    // amount and a three-letter currency, with the currency canonicalised to
    // upper case so a provider's lower-case wire value is accepted.
    const valid: [unknown, unknown, Money][] = [
      [1000, "GBP", { amount: 1000, currency: "GBP" }],
      [0, "gbp", { amount: 0, currency: "GBP" }],
      [1050, "EuR", { amount: 1050, currency: "EUR" }],
    ];
    for (const [amount, currency, expected] of valid) {
      it(`builds ${JSON.stringify(expected)} from amount=${String(amount)} currency=${String(currency)}`, () => {
        expect(money(amount, currency)).toEqual(expected);
      });
    }

    // The cases the provider boundary must refuse: a fractional, negative, NaN,
    // non-number, or null amount, and a currency that is not three letters.
    const malformed: [unknown, unknown, string][] = [
      [10.5, "GBP", "fractional amount"],
      [-5, "GBP", "negative amount"],
      [Number.NaN, "GBP", "NaN amount"],
      [Number.MAX_SAFE_INTEGER + 1, "GBP", "unsafe-integer amount"],
      ["1000", "GBP", "string amount"],
      [null, "GBP", "null amount"],
      [1000, "GB", "two-letter currency"],
      [1000, "GBPX", "four-letter currency"],
      [1000, "", "blank currency"],
      [1000, null, "null currency"],
      [1000, 123, "non-string currency"],
      [null, null, "null amount and currency"],
    ];
    for (const [amount, currency, reason] of malformed) {
      it(`refuses ${reason} (amount=${String(amount)}, currency=${String(currency)})`, () => {
        expect(money(amount, currency)).toBe(null);
      });
    }
  });

  describe("CurrencySchema", () => {
    it("accepts three uppercase letters and nothing else", () => {
      expect(v.is(CurrencySchema, "GBP")).toBe(true);
      expect(v.is(CurrencySchema, "gbp")).toBe(false);
      expect(v.is(CurrencySchema, "GB")).toBe(false);
      expect(v.is(CurrencySchema, "GBPX")).toBe(false);
      expect(v.is(CurrencySchema, "")).toBe(false);
    });
  });

  describe("MoneySchema", () => {
    it("round-trips a built money value through the schema", () => {
      expect(v.parse(MoneySchema, { amount: 2500, currency: "USD" })).toEqual({
        amount: 2500,
        currency: "USD",
      });
    });
  });
});
