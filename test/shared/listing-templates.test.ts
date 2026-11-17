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
  subscribed = false,
) => ({
  date: dated ? "2024-06-01T10:00:00Z" : "",
  listingType: (daily ? "daily" : "standard") as "daily" | "standard",
  purchaseOnly: purchaseable,
  recurringPrice: subscribed ? 1500 : 0,
  usesLogistics: logistics,
});

const dims = (
  daily: boolean,
  dated: boolean,
  purchaseable: boolean,
  logistics: boolean,
): Dimensions => ({
  daily,
  dated,
  logistics,
  purchaseable,
  subscribed: false,
});

// ---------------------------------------------------------------------------
// dimensionsOf
// ---------------------------------------------------------------------------

describe("dimensionsOf", () => {
  test("reads every dimension from its own column", () => {
    expect(dimensionsOf(src(true, true, true, true, true))).toEqual({
      daily: true,
      dated: true,
      logistics: true,
      purchaseable: true,
      subscribed: true,
    });
    expect(dimensionsOf(src(false, false, false, false, false))).toEqual({
      daily: false,
      dated: false,
      logistics: false,
      purchaseable: false,
      subscribed: false,
    });
  });

  test("a recurring price of one minor unit counts as subscribed", () => {
    const source = { ...src(false, false, false, false), recurringPrice: 1 };
    expect(dimensionsOf(source).subscribed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inferTemplate — exhaustive table over all 32 combos
// ---------------------------------------------------------------------------

//  Key: [daily, dated, purchaseable, logistics, subscribed] → TemplateId | null
//
//  one-off-event : daily=false, dated=true,  purch=false, logis=false, subs=false (×1)
//  weekly-event  : daily=true,  dated=?,     purch=false, logis=false, subs=false (×2)
//  online-digital: daily=false, dated=false, purch=true,  logis=false, subs=false (×1)
//  hireable-item : purch=true,  logis=true,  daily=?,     dated=?,     subs=false (×4)
//  subscription  : daily=false, dated=false, purch=?,     logis=?,     subs=true  (×4)
//  null (Custom) : all other combos                                              (×20)
//
//  day-pass, physical-product and donation share a signature with an earlier
//  template, so no combo infers them.
/* jscpd:ignore-start -- a table of literals, not code */
const TABLE: Array<{
  combo: [boolean, boolean, boolean, boolean, boolean];
  expected: TemplateId | null;
}> = [
  { combo: [false, false, false, false, false], expected: null },
  { combo: [false, true, false, false, false], expected: "one-off-event" },
  { combo: [false, false, true, false, false], expected: "online-digital" },
  { combo: [false, true, true, false, false], expected: null },
  { combo: [false, false, false, true, false], expected: null },
  { combo: [false, true, false, true, false], expected: null },
  { combo: [false, false, true, true, false], expected: "hireable-item" },
  { combo: [false, true, true, true, false], expected: "hireable-item" },
  { combo: [true, false, false, false, false], expected: "weekly-event" },
  { combo: [true, true, false, false, false], expected: "weekly-event" }, // dated ignored for daily
  { combo: [true, false, true, false, false], expected: null },
  { combo: [true, true, true, false, false], expected: null },
  { combo: [true, false, false, true, false], expected: null },
  { combo: [true, true, false, true, false], expected: null },
  { combo: [true, false, true, true, false], expected: "hireable-item" }, // daily ignored for hireable
  { combo: [true, true, true, true, false], expected: "hireable-item" }, // both ignored for hireable
  { combo: [false, false, false, false, true], expected: "subscription" },
  { combo: [false, true, false, false, true], expected: null },
  { combo: [false, false, true, false, true], expected: "subscription" }, // a posted subscription
  { combo: [false, true, true, false, true], expected: null },
  { combo: [false, false, false, true, true], expected: "subscription" },
  { combo: [false, true, false, true, true], expected: null },
  { combo: [false, false, true, true, true], expected: "subscription" },
  { combo: [false, true, true, true, true], expected: null },
  { combo: [true, false, false, false, true], expected: null },
  { combo: [true, true, false, false, true], expected: null },
  { combo: [true, false, true, false, true], expected: null },
  { combo: [true, true, true, false, true], expected: null },
  { combo: [true, false, false, true, true], expected: null },
  { combo: [true, true, false, true, true], expected: null },
  { combo: [true, false, true, true, true], expected: null },
  { combo: [true, true, true, true, true], expected: null },
];
/* jscpd:ignore-end */

describe("inferTemplate — all 32 dimension combos", () => {
  for (const { combo, expected } of TABLE) {
    const [daily, dated, purchaseable, logistics, subscribed] = combo;
    const label = `(daily=${daily}, dated=${dated}, purch=${purchaseable}, logis=${logistics}, subs=${subscribed})`;
    test(`${label} → ${expected ?? "null (Custom)"}`, () => {
      expect(
        inferTemplate(src(daily, dated, purchaseable, logistics, subscribed))
          ?.id ?? null,
      ).toBe(expected);
    });
  }

  test("the table holds every combo once, and 12 of them name a template", () => {
    expect(new Set(TABLE.map(({ combo }) => combo.join())).size).toBe(32);
    expect(TABLE.filter(({ expected }) => expected !== null)).toHaveLength(12);
  });
});

describe("inferTemplate — shared signatures", () => {
  // Each pair shares one signature. Inference returns the first match in
  // LISTING_TEMPLATES order, so the first id of each pair is what an edit
  // shows. The picker still offers every card.
  const SHARED: [TemplateId, TemplateId][] = [
    ["weekly-event", "day-pass"],
    ["online-digital", "physical-product"],
    ["online-digital", "donation"],
  ];
  const position = (id: TemplateId) =>
    LISTING_TEMPLATES.findIndex((tmpl) => tmpl.id === id);

  for (const [inferred, hidden] of SHARED) {
    test(`${inferred} comes before ${hidden}, which shares its signature`, () => {
      expect(position(inferred)).toBeGreaterThan(-1);
      expect(position(inferred)).toBeLessThan(position(hidden));
      expect(LISTING_TEMPLATES[position(hidden)]?.signature).toEqual(
        LISTING_TEMPLATES[position(inferred)]?.signature,
      );
    });
  }
});

describe("inferTemplate — template flags", () => {
  test("only one-off-event requires a date", () => {
    const dateRequired = LISTING_TEMPLATES.filter((t) => t.requiresDate);
    expect(dateRequired.map((t) => t.id)).toEqual(["one-off-event"]);
  });

  test("only hireable-item and subscription need a site feature", () => {
    const gated = LISTING_TEMPLATES.filter((t) => t.requires !== null).map(
      (t) => [t.id, t.requires],
    );
    expect(gated).toEqual([
      ["hireable-item", "logistics"],
      ["subscription", "subscriptions"],
    ]);
  });

  // Pins the exact key per template. i18n's t() throws on an unknown key,
  // but only for a key that some test renders.
  /* jscpd:ignore-start -- a list of strings, not code */
  const EXPECTED_LABELS: Record<TemplateId, string> = {
    "day-pass": "listings_table.template_day_pass",
    donation: "listings_table.template_donation",
    "hireable-item": "listings_table.template_hireable_item",
    "one-off-event": "listings_table.template_one_off_event",
    "online-digital": "listings_table.template_online_digital",
    "physical-product": "listings_table.template_physical_product",
    subscription: "listings_table.template_subscription",
    "weekly-event": "listings_table.template_weekly_event",
  };
  /* jscpd:ignore-end */

  for (const tmpl of LISTING_TEMPLATES) {
    test(`${tmpl.id} has its exact label and description i18n key`, () => {
      expect({ description: tmpl.description, label: tmpl.label }).toEqual({
        description: `${EXPECTED_LABELS[tmpl.id]}_description`,
        label: EXPECTED_LABELS[tmpl.id],
      });
    });
  }
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
