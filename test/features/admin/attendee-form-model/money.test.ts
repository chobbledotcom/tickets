import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseAttendeeForm,
  receiptsOf,
  toLedgerOrder,
} from "#routes/admin/attendee-form-model.ts";
import { validateParsedForm } from "#routes/admin/attendee-form-validation.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { line, makeForm, parsedBase } from "./fixtures.ts";

describe("parseAttendeeForm money slots", () => {
  test("reads submitted slots blank-aligned, so values never shift", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        adjustmentAmount0: "-500",
        adjustmentDescription0: "Delivery",
        paymentAmount1: "2000",
      }),
      new Map(),
    );
    expect(parsed.payments).toEqual([null, "2000", null]);
    expect(parsed.adjustments).toEqual([
      { amount: "-500", description: "Delivery", taxable: false },
      null,
      null,
    ]);
  });

  test("reads the tax box of an adjustment slot", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        adjustmentAmount1: "250",
        adjustmentDescription1: "Delivery",
        adjustmentTaxable1: "1",
      }),
      new Map(),
    );
    expect(parsed.adjustments).toEqual([
      null,
      { amount: "250", description: "Delivery", taxable: true },
      null,
    ]);
  });

  test("keeps a half-filled adjustment slot for its error to show", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        adjustmentDescription2: "Delivery",
        name: "X",
      }),
      new Map(),
    );
    expect(parsed.adjustments).toEqual([
      null,
      null,
      { amount: "", description: "Delivery", taxable: false },
    ]);
  });

  test("reads a line's agreed price raw", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        lineListing0: "3",
        name: "X",
        price0: "1200",
        qty0: "2",
      }),
      new Map(),
    );
    expect(parsed.lines[0]!.priceRaw).toBe("1200");
  });
});

describe("toLedgerOrder with an agreed price", () => {
  const listing = testListingWithCount({ id: 3, unitPrice: 900 });

  test("the operator's agreed price wins over the package override", () => {
    const parsed = parsedBase({
      lines: [
        line({
          listing,
          listingId: 3,
          packageGroupId: 4,
          packagePrice: 700,
          priceRaw: "500",
          quantity: 2,
        }),
      ],
    });
    const order = toLedgerOrder(parsed, []);
    expect(order.lines[0]!.item.unitPrice).toBe(500);
    expect(order.lines[0]!.chargedUnitAmount).toBe(500);
  });

  test("a blank price keeps the package path's override", () => {
    const parsed = parsedBase({
      lines: [
        line({ listing, listingId: 3, packageGroupId: 4, packagePrice: 700 }),
      ],
    });
    expect(toLedgerOrder(parsed, []).lines[0]!.item.unitPrice).toBe(700);
  });

  test("a blank price with no package falls back to the list price", () => {
    const parsed = parsedBase({
      lines: [line({ listing, listingId: 3 })],
    });
    expect(toLedgerOrder(parsed, []).lines[0]!.item.unitPrice).toBe(900);
  });
});

describe("toLedgerOrder with a taxable adjustment", () => {
  const listing = testListingWithCount({ id: 3, unitPrice: 1000 });

  test("the taxable adjustments join the tax basis and the others stay out", () => {
    const order = toLedgerOrder(
      parsedBase({ lines: [line({ listing, listingId: 3 })] }),
      [
        { amount: 500, description: "Delivery", taxable: true },
        { amount: 300, description: "Fee" },
      ],
    );
    expect(order.tax.basis.charges).toEqual([{ gross: 500 }]);
    expect(order.tax.taxableTotal).toBe(1500);
  });
});

describe("money validation", () => {
  test("refuses a taxable writeoff and accepts a taxable charge", () => {
    const refused = validateParsedForm(
      parsedBase({
        adjustments: [
          { amount: "-500", description: "Goodwill", taxable: true },
        ],
      }),
    );
    expect(refused.valid).toBe(false);
    if (!refused.valid) {
      expect(refused.formError).toBe(
        "A writeoff cannot carry tax. Clear the tax box, or enter a positive amount.",
      );
    }
    expect(
      validateParsedForm(
        parsedBase({
          adjustments: [
            { amount: "500", description: "Delivery", taxable: true },
          ],
        }),
      ).valid,
    ).toBe(true);
  });

  test("refuses a payment that is not a positive whole amount", () => {
    for (const raw of ["0", "12ab", "-5"]) {
      const result = validateParsedForm(parsedBase({ payments: [raw] }));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.formError).toBe(
          "Enter a positive whole number of pence or cents for each payment.",
        );
      }
    }
  });

  test("accepts a valid payment", () => {
    const result = validateParsedForm(parsedBase({ payments: ["1", "2000"] }));
    expect(result.valid).toBe(true);
  });

  test("refuses an adjustment with no description", () => {
    const result = validateParsedForm(
      parsedBase({ adjustments: [{ amount: "500", description: "" }] }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.formError).toBe(
        "Every charge or writeoff needs a description.",
      );
    }
  });

  test("accepts a 200-character description and refuses a longer one", () => {
    const description = "d".repeat(200);
    expect(
      validateParsedForm(
        parsedBase({ adjustments: [{ amount: "500", description }] }),
      ).valid,
    ).toBe(true);
    const result = validateParsedForm(
      parsedBase({
        adjustments: [{ amount: "500", description: `${description}d` }],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.formError).toBe(
        "Keep each description to 200 characters or fewer.",
      );
    }
  });

  test("refuses an adjustment amount that is not a signed whole number", () => {
    for (const amount of ["", "12ab", "0", "1.5", "99999999999999999999"]) {
      const result = validateParsedForm(
        parsedBase({ adjustments: [{ amount, description: "Delivery" }] }),
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.formError).toBe(
          "Enter a whole number of pence or cents, not zero.",
        );
      }
    }
  });

  test("accepts a negative adjustment as a writeoff", () => {
    const result = validateParsedForm(
      parsedBase({
        adjustments: [{ amount: "-500", description: "Delivery" }],
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("refuses an agreed price that is not a whole amount", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [line({ listingId: 3, priceRaw: "12ab", quantity: 1 })],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.lineErrors.get(0)).toBe(
        "Enter a whole number of pence or cents for the agreed price, or leave it blank.",
      );
    }
  });

  test("refuses an agreed price on a row that books nothing", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [line({ listingId: 3, priceRaw: "500", quantity: null })],
      }),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.lineErrors.get(0)).toBe(
        "A price needs a quantity on the same row.",
      );
    }
  });

  test("accepts an agreed price on a booked row", () => {
    const result = validateParsedForm(
      parsedBase({
        lines: [line({ listingId: 3, priceRaw: "500", quantity: 1 })],
      }),
    );
    expect(result.valid).toBe(true);
  });
});

describe("receiptsOf", () => {
  test("converts the validated slots into the ledger's receipts", () => {
    const receipts = receiptsOf(
      parsedBase({
        adjustments: [
          { amount: "-500", description: "Delivery" },
          null,
          { amount: "750", description: "Extra hours", taxable: true },
        ],
        payments: ["2000", null, "250"],
      }),
    );
    expect(receipts).toEqual({
      adjustments: [
        { amount: -500, description: "Delivery" },
        { amount: 750, description: "Extra hours", taxable: true },
      ],
      payments: [2000, 250],
    });
  });

  test("an empty form records no receipts", () => {
    expect(receiptsOf(parsedBase())).toEqual({
      adjustments: [],
      payments: [],
    });
  });

  test("drops an adjustment slot the validation would refuse", () => {
    const receipts = receiptsOf(
      parsedBase({
        adjustments: [
          { amount: "abc", description: "Not a number" },
          { amount: "0", description: "Zero amount" },
        ],
      }),
    );
    expect(receipts).toEqual({ adjustments: [], payments: [] });
  });

  test("drops a payment slot the validation would refuse", () => {
    const receipts = receiptsOf(
      parsedBase({ payments: ["not-a-number", "0"] }),
    );
    expect(receipts).toEqual({ adjustments: [], payments: [] });
  });
});
