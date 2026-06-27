import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import {
  type Dimensions,
  dimensionsOf,
  inferTemplate,
  LISTING_TEMPLATES,
  submissionRequiresDate,
  type TemplateId,
} from "#shared/listing-templates.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DimensionSource from raw booleans. */
const src = (
  daily: boolean,
  dated: boolean,
  purchaseable: boolean,
  logistics: boolean,
) => ({
  date: dated ? "2024-06-01T10:00:00Z" : "",
  listing_type: (daily ? "daily" : "standard") as "daily" | "standard",
  purchase_only: purchaseable,
  uses_logistics: logistics,
});

const dims = (
  daily: boolean,
  dated: boolean,
  purchaseable: boolean,
  logistics: boolean,
): Dimensions => ({ daily, dated, logistics, purchaseable });

// ---------------------------------------------------------------------------
// dimensionsOf
// ---------------------------------------------------------------------------

describe("dimensionsOf", () => {
  test("maps listing_type=daily to daily=true", () => {
    expect(dimensionsOf(src(true, false, false, false)).daily).toBe(true);
  });

  test("maps listing_type=standard to daily=false", () => {
    expect(dimensionsOf(src(false, false, false, false)).daily).toBe(false);
  });

  test("maps non-empty date to dated=true", () => {
    expect(dimensionsOf(src(false, true, false, false)).dated).toBe(true);
  });

  test("maps empty date to dated=false", () => {
    expect(dimensionsOf(src(false, false, false, false)).dated).toBe(false);
  });

  test("maps purchase_only to purchaseable", () => {
    expect(dimensionsOf(src(false, false, true, false)).purchaseable).toBe(
      true,
    );
    expect(dimensionsOf(src(false, false, false, false)).purchaseable).toBe(
      false,
    );
  });

  test("maps uses_logistics to logistics", () => {
    expect(dimensionsOf(src(false, false, false, true)).logistics).toBe(true);
    expect(dimensionsOf(src(false, false, false, false)).logistics).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// inferTemplate — exhaustive table over all 16 (daily×dated×purch×logis) combos
// ---------------------------------------------------------------------------

// Expected inference: 8 of 16 combos map to a named template.
//
//  Key: [daily, dated, purchaseable, logistics] → expected TemplateId | null
//
//  one-off-event   : daily=false, dated=true,  purch=false, logis=false     (×1)
//  weekly-event    : daily=true,  dated=?,      purch=false, logis=false     (×2)
//  online-digital  : daily=false, dated=false,  purch=true,  logis=false     (×1)
//  hireable-item   : purch=true,  logis=true,   daily=?,     dated=?         (×4)
//  null (Custom)   : all other combos                                        (×8)
const TABLE: Array<{
  combo: [boolean, boolean, boolean, boolean];
  expected: TemplateId | null;
}> = [
  { combo: [false, false, false, false], expected: null },
  { combo: [false, true, false, false], expected: "one-off-event" },
  { combo: [false, false, true, false], expected: "online-digital" },
  { combo: [false, true, true, false], expected: null },
  { combo: [false, false, false, true], expected: null },
  { combo: [false, true, false, true], expected: null },
  { combo: [false, false, true, true], expected: "hireable-item" },
  { combo: [false, true, true, true], expected: "hireable-item" },
  { combo: [true, false, false, false], expected: "weekly-event" },
  { combo: [true, true, false, false], expected: "weekly-event" }, // dated ignored for daily
  { combo: [true, false, true, false], expected: null },
  { combo: [true, true, true, false], expected: null },
  { combo: [true, false, false, true], expected: null },
  { combo: [true, true, false, true], expected: null },
  { combo: [true, false, true, true], expected: "hireable-item" }, // daily ignored for hireable
  { combo: [true, true, true, true], expected: "hireable-item" }, // both ignored for hireable
];

describe("inferTemplate — all 16 dimension combos", () => {
  for (const { combo, expected } of TABLE) {
    const [daily, dated, purchaseable, logistics] = combo;
    const label = `(daily=${daily}, dated=${dated}, purch=${purchaseable}, logis=${logistics})`;
    test(`${label} → ${expected ?? "null (Custom)"}`, () => {
      expect(
        inferTemplate(src(daily, dated, purchaseable, logistics))?.id ?? null,
      ).toBe(expected);
    });
  }
});

describe("inferTemplate — mutual exclusivity", () => {
  test("no combo maps to more than one template", () => {
    for (const { combo } of TABLE) {
      const [daily, dated, purchaseable, logistics] = combo;
      const matches = LISTING_TEMPLATES.filter(
        (tmpl) =>
          inferTemplate(src(daily, dated, purchaseable, logistics))?.id ===
          tmpl.id,
      );
      expect(matches.length).toBeLessThanOrEqual(1);
    }
  });

  test("exactly 8 of 16 combos match a named template", () => {
    const matched = TABLE.filter(({ expected }) => expected !== null);
    expect(matched).toHaveLength(8);
  });
});

describe("inferTemplate — dated asymmetry for daily types", () => {
  test("weekly-event matches daily=true regardless of dated", () => {
    expect(inferTemplate(src(true, false, false, false))?.id).toBe(
      "weekly-event",
    );
    expect(inferTemplate(src(true, true, false, false))?.id).toBe(
      "weekly-event",
    );
  });

  test("hireable-item matches regardless of both daily and dated", () => {
    expect(inferTemplate(src(false, false, true, true))?.id).toBe(
      "hireable-item",
    );
    expect(inferTemplate(src(false, true, true, true))?.id).toBe(
      "hireable-item",
    );
    expect(inferTemplate(src(true, false, true, true))?.id).toBe(
      "hireable-item",
    );
    expect(inferTemplate(src(true, true, true, true))?.id).toBe(
      "hireable-item",
    );
  });
});

describe("inferTemplate — price is not a dimension", () => {
  test("one-off-event infers regardless of unit_price", () => {
    // DimensionSource does not include unit_price; pricing is orthogonal.
    const base = src(false, true, false, false);
    expect(inferTemplate(base)?.id).toBe("one-off-event");
    // Adding extra fields to the source doesn't affect inference.
    expect(inferTemplate({ ...base, unit_price: 0 } as typeof base)?.id).toBe(
      "one-off-event",
    );
    expect(
      inferTemplate({ ...base, unit_price: 1000 } as typeof base)?.id,
    ).toBe("one-off-event");
  });
});

describe("inferTemplate — template flags", () => {
  test("only one-off-event requires a date", () => {
    const dateRequired = LISTING_TEMPLATES.filter((t) => t.requiresDate);
    expect(dateRequired.map((t) => t.id)).toEqual(["one-off-event"]);
  });

  test("only hireable-item requires logistics", () => {
    const logisticsRequired = LISTING_TEMPLATES.filter(
      (t) => t.requiresLogistics,
    );
    expect(logisticsRequired.map((t) => t.id)).toEqual(["hireable-item"]);
  });

  test("all templates have label and description i18n keys", () => {
    for (const tmpl of LISTING_TEMPLATES) {
      expect(tmpl.label).toMatch(/^listings_table\./);
      expect(tmpl.description).toMatch(/^listings_table\./);
    }
  });
});

// ---------------------------------------------------------------------------
// submissionRequiresDate — truth table
// ---------------------------------------------------------------------------

describe("submissionRequiresDate", () => {
  // The condition fires ONLY when:
  //   chosenTemplateId === "one-off-event"  AND
  //   daily=false AND purchaseable=false AND logistics=false

  test("returns true for the one-off-event shape", () => {
    expect(
      submissionRequiresDate("one-off-event", dims(false, false, false, false)),
    ).toBe(true);
  });

  test("returns true even when dated=true (function checks only non-date dims)", () => {
    // dated is not checked — the caller separately tests if date is blank.
    expect(
      submissionRequiresDate("one-off-event", dims(false, true, false, false)),
    ).toBe(true);
  });

  test("returns false when chosenTemplateId is null", () => {
    expect(submissionRequiresDate(null, dims(false, false, false, false))).toBe(
      false,
    );
  });

  test("returns false for a different template id", () => {
    expect(
      submissionRequiresDate("weekly-event", dims(false, false, false, false)),
    ).toBe(false);
  });

  test("returns false for an unknown template id string", () => {
    expect(
      submissionRequiresDate("custom", dims(false, false, false, false)),
    ).toBe(false);
  });

  test("returns false when daily=true (operator changed to weekly shape)", () => {
    expect(
      submissionRequiresDate("one-off-event", dims(true, false, false, false)),
    ).toBe(false);
  });

  test("returns false when purchaseable=true (operator changed shape)", () => {
    expect(
      submissionRequiresDate("one-off-event", dims(false, false, true, false)),
    ).toBe(false);
  });

  test("returns false when logistics=true (operator changed shape)", () => {
    expect(
      submissionRequiresDate("one-off-event", dims(false, false, false, true)),
    ).toBe(false);
  });
});
