import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import * as v from "valibot";
import { assessTax } from "#shared/tax/assessment.ts";
import {
  TaxAssessmentSchema,
  type TaxBasisInput,
  type TaxPolicy,
} from "#shared/tax/types.ts";

const basis: TaxBasisInput = {
  lines: [{ gross: 10000, listingId: 1 }],
  modifiers: [],
};
const added: TaxPolicy = { mode: "add_to_total", rateBasisPoints: 2000 };
const included: TaxPolicy = {
  mode: "calculate_from_total",
  rateBasisPoints: 2000,
};

describe("a booking tax assessment", () => {
  it("adds tax to the listed amount without a change to income", () => {
    expect(assessTax(basis, added)).toEqual({
      basis: { ...basis, charges: [] },
      charges: [],
      lines: basis.lines,
      modifiers: [],
      policy: added,
      taxAmount: 2000,
      taxableTotal: 10000,
      total: 12000,
    });
  });

  it("extracts included tax and keeps the customer total", () => {
    const assessment = assessTax(basis, included);
    expect(assessment.taxAmount).toBe(1667);
    expect(assessment.lines).toEqual([{ gross: 8333, listingId: 1 }]);
    expect(assessment.total).toBe(10000);
    expect(assessment.lines[0]!.gross + assessment.taxAmount).toBe(10000);
  });

  it("keeps discounts whole and divides included tax across sales and surcharges", () => {
    const assessment = assessTax(
      {
        lines: [{ gross: 12000, listingId: 1 }],
        modifiers: [
          { delta: -1000, modifierId: 10 },
          { delta: 200, modifierId: 11 },
        ],
      },
      included,
    );
    expect(assessment.taxAmount).toBe(1867);
    expect(assessment.lines).toEqual([{ gross: 10164, listingId: 1 }]);
    expect(assessment.modifiers).toEqual([
      { delta: -1000, modifierId: 10 },
      { delta: 169, modifierId: 11 },
    ]);
    expect(assessment.total).toBe(11200);
  });

  it("does not compound tax when a policy changes and returns", () => {
    const first = assessTax(basis, added);
    const second = assessTax(first.basis, included);
    expect(assessTax(second.basis, added)).toEqual(first);
    expect(second.total).toBe(10000);
  });

  it("records a zero-rate assessment without a tax leg amount", () => {
    const assessment = assessTax(basis, {
      mode: "add_to_total",
      rateBasisPoints: 0,
    });
    expect(assessment.taxAmount).toBe(0);
    expect(assessment.total).toBe(10000);
    expect(assessment.policy).toEqual({
      mode: "add_to_total",
      rateBasisPoints: 0,
    });
  });

  it("keeps a fully discounted booking free", () => {
    const assessment = assessTax(
      { ...basis, modifiers: [{ delta: -10000, modifierId: 2 }] },
      added,
    );
    expect(assessment.taxAmount).toBe(0);
    expect(assessment.total).toBe(0);
  });

  it("rounds a half minor unit upwards", () => {
    expect(
      assessTax(
        { lines: [{ gross: 999, listingId: 1 }], modifiers: [] },
        included,
      ).taxAmount,
    ).toBe(167);
  });

  it("calculates an exact ratio beyond safe intermediate multiplication", () => {
    const assessment = assessTax(
      { lines: [{ gross: 8000000000000000, listingId: 1 }], modifiers: [] },
      { mode: "add_to_total", rateBasisPoints: 1 },
    );
    expect(assessment.taxAmount).toBe(800000000000);
    expect(assessment.total).toBe(8000800000000000);
  });

  for (const [name, policy, expected] of [
    [
      "taxes a taxable charge with the lines",
      added,
      {
        charges: [{ gross: 2000 }],
        lines: basis.lines,
        taxAmount: 2400,
        taxableTotal: 12000,
        total: 14400,
      },
    ],
    [
      "takes included tax out of a taxable charge as well as the lines",
      included,
      {
        charges: [{ gross: 1667 }],
        lines: [{ gross: 8333, listingId: 1 }],
        taxAmount: 2000,
        taxableTotal: 12000,
        total: 12000,
      },
    ],
  ] as const) {
    it(name, () => {
      expect(
        assessTax({ ...basis, charges: [{ gross: 2000 }] }, policy),
      ).toMatchObject(expected);
    });
  }

  it("reads a stored assessment from before charges existed", () => {
    const { charges: _basisCharges, ...legacyBasis } = assessTax(
      basis,
      added,
    ).basis;
    const { charges: _charges, ...legacy } = assessTax(basis, added);
    const stored = v.parse(TaxAssessmentSchema, {
      ...legacy,
      basis: legacyBasis,
    });
    expect(stored.charges).toEqual([]);
    expect(stored.basis.charges).toEqual([]);
  });
});
