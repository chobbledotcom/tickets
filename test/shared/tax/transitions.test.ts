import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { assessTax } from "#shared/tax/assessment.ts";
import {
  reassessTax,
  refundTax,
  sameTaxPolicy,
  TAX_STATE_KINDS,
  type TaxState,
} from "#shared/tax/transitions.ts";
import { NO_TAX, type TaxPolicy } from "#shared/tax/types.ts";

const basis = { lines: [{ gross: 1000, listingId: 1 }], modifiers: [] };
const atTwenty: TaxPolicy = { mode: "add_to_total", rateBasisPoints: 2000 };
const atTen: TaxPolicy = { mode: "add_to_total", rateBasisPoints: 1000 };
const includedAtTwenty: TaxPolicy = {
  mode: "calculate_from_total",
  rateBasisPoints: 2000,
};

const assessed = (
  kind: TaxState["kind"],
  revision: number,
  policy: TaxPolicy,
): TaxState => ({ assessment: assessTax(basis, policy), kind, revision });

describe("tax assessment transitions", () => {
  test("names the two states", () => {
    expect(TAX_STATE_KINDS).toEqual(["active", "refunded"]);
  });

  test("tells two policies apart", () => {
    expect(sameTaxPolicy(NO_TAX, NO_TAX)).toBe(true);
    expect(sameTaxPolicy(atTwenty, atTwenty)).toBe(true);
    expect(sameTaxPolicy(atTwenty, atTen)).toBe(false);
    expect(sameTaxPolicy(atTwenty, includedAtTwenty)).toBe(false);
    expect(sameTaxPolicy(NO_TAX, atTwenty)).toBe(false);
    expect(sameTaxPolicy(atTwenty, NO_TAX)).toBe(false);
  });

  test("refuses a save against an older revision", () => {
    expect(() =>
      reassessTax(assessed("active", 2, NO_TAX), atTwenty, 1),
    ).toThrow("The booking tax assessment changed. Reload the attendee.");
  });

  test("keeps a refunded assessment as it is", () => {
    const refunded = assessed("refunded", 3, NO_TAX);

    expect(reassessTax(refunded, atTwenty, 3)).toEqual({
      after: refunded,
      before: refunded,
      kind: "unchanged",
    });
  });

  test("keeps an assessment whose policy did not change", () => {
    const active = assessed("active", 3, atTwenty);

    expect(reassessTax(active, atTwenty, 3)).toEqual({
      after: active,
      before: active,
      kind: "unchanged",
    });
  });

  test("reassesses a save that changes the policy", () => {
    const active = assessed("active", 3, NO_TAX);

    expect(reassessTax(active, atTwenty, 3)).toEqual({
      after: {
        assessment: assessTax(basis, atTwenty),
        kind: "active",
        revision: 4,
      },
      before: active,
      kind: "reassessed",
    });
  });

  test("refuses a refund against an older revision", () => {
    expect(() => refundTax(assessed("active", 2, NO_TAX), 1)).toThrow(
      "The booking tax assessment changed. Reload the refund.",
    );
  });

  test("leaves an assessment that is already refunded", () => {
    const refunded = assessed("refunded", 3, NO_TAX);

    expect(refundTax(refunded, 3)).toBe(refunded);
  });

  test("closes an active assessment", () => {
    const active = assessed("active", 3, atTwenty);

    expect(refundTax(active, 3)).toEqual({
      assessment: active.assessment,
      kind: "refunded",
      revision: 4,
    });
  });
});
