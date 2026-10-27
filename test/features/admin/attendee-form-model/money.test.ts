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
        adjustment_amount_0: "-500",
        adjustment_description_0: "Delivery",
        payment_amount_1: "2000",
      }),
      new Map(),
    );
    expect(parsed.payments).toEqual([null, "2000", null]);
    expect(parsed.adjustments).toEqual([
      { amount: "-500", description: "Delivery" },
      null,
      null,
    ]);
  });

  test("keeps a half-filled adjustment slot for its error to show", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        adjustment_description_2: "Delivery",
        name: "X",
      }),
      new Map(),
    );
    expect(parsed.adjustments).toEqual([
      null,
      null,
      { amount: "", description: "Delivery" },
    ]);
  });

  test("reads a line's agreed price raw", () => {
    const parsed = parseAttendeeForm(
      makeForm({
        line_listing_0: "3",
        name: "X",
        price_0: "1200",
        qty_0: "2",
      }),
      new Map(),
    );
    expect(parsed.lines[0]!.priceRaw).toBe("1200");
  });
});

describe("toLedgerOrder with an agreed price", () => {
  const listing = testListingWithCount({ id: 3, unit_price: 900 });

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
    const order = toLedgerOrder(parsed);
    expect(order.lines[0]!.item.unitPrice).toBe(500);
    expect(order.lines[0]!.chargedUnitAmount).toBe(500);
  });

  test("a blank price keeps the package path's override", () => {
    const parsed = parsedBase({
      lines: [
        line({ listing, listingId: 3, packageGroupId: 4, packagePrice: 700 }),
      ],
    });
    expect(toLedgerOrder(parsed).lines[0]!.item.unitPrice).toBe(700);
  });

  test("a blank price with no package falls back to the list price", () => {
    const parsed = parsedBase({
      lines: [line({ listing, listingId: 3 })],
    });
    expect(toLedgerOrder(parsed).lines[0]!.item.unitPrice).toBe(900);
  });
});

describe("money validation", () => {
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
          { amount: "750", description: "Extra hours" },
        ],
        payments: ["2000", null, "250"],
      }),
    );
    expect(receipts).toEqual({
      adjustments: [
        { amount: -500, description: "Delivery" },
        { amount: 750, description: "Extra hours" },
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
});
