/**
 * Contracts for the money-page reading helpers. The stories rely on these to
 * pick a figure out of the right part of a rendered page, so a silent change
 * here would weaken every money assertion built on them.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import {
  incomeLedgerArticle,
  signedCurrency,
} from "#test-utils/money/reads.ts";

describe("money reads", () => {
  describe("signedCurrency", () => {
    test("leads a positive figure with a plus", () => {
      expect(signedCurrency(500)).toBe(`+${formatCurrency(500)}`);
    });

    test("leads a negative figure with a minus sign, not a hyphen", () => {
      expect(signedCurrency(-500)).toBe(`−${formatCurrency(500)}`);
      expect(signedCurrency(-500)).not.toContain("-");
    });

    test("treats zero as a positive figure", () => {
      expect(signedCurrency(0)).toBe(`+${formatCurrency(0)}`);
    });
  });

  describe("incomeLedgerArticle", () => {
    const page = [
      "<p>£99 elsewhere on the page</p>",
      '<article id="income-ledger"><p>£45 inside</p></article>',
      "<p>£77 after the breakdown</p>",
    ].join("");

    test("returns only the breakdown, so a figure elsewhere cannot match", () => {
      const article = incomeLedgerArticle(page);
      expect(article).toContain("£45 inside");
      expect(article).not.toContain("£99");
      expect(article).not.toContain("£77");
    });

    test("throws when the page has no breakdown at all", () => {
      expect(() => incomeLedgerArticle("<p>no breakdown here</p>")).toThrow();
    });
  });
});
