import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { isCurrency, money } from "#payment/money.ts";

describe("money", () => {
  // The cases that must build a charge: a non-negative whole minor-unit
  // amount and a three-letter currency, with the currency canonicalised to
  // upper case so a provider's lower-case wire value is accepted.
  const valid: [unknown, unknown, { amount: number; currency: string }][] = [
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

  // The guard an adapter asks before handing a provider's currency to Intl,
  // which throws on anything that is not a real code. It answers for the value
  // as given — "gbp" is only well formed once `money` has upper-cased it.
  const wellFormed: [unknown, boolean][] = [
    ["GBP", true],
    ["gbp", false],
    ["GB", false],
    ["GBPX", false],
    ["G B", false],
    ["", false],
    [null, false],
    [123, false],
  ];
  for (const [value, expected] of wellFormed) {
    it(`says ${String(value)} is ${expected ? "" : "not "}a currency code`, () => {
      expect(isCurrency(value)).toBe(expected);
    });
  }
});
