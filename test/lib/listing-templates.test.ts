import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type DimensionSource,
  type Dimensions,
  dimensionsOf,
  inferTemplate,
  LISTING_TEMPLATES,
  matchesSignature,
  ONE_OFF_TEMPLATE_ID,
  submissionRequiresDate,
  type TemplateId,
} from "#shared/listing-templates.ts";
import type { ListingType } from "#shared/types.ts";
import { testListing } from "#test-utils";

/** Build the minimal listing fields inference reads, from the four dimensions. */
const sourceOf = (dims: Dimensions): DimensionSource => ({
  date: dims.dated ? "2026-01-01T00:00:00Z" : "",
  listing_type: (dims.daily ? "daily" : "standard") as ListingType,
  purchase_only: dims.purchaseable,
  uses_logistics: dims.logistics,
});

/** All 16 `(daily, dated, purchaseable, logistics)` combinations paired with the
 * template each must infer to (`null` = Custom). This table IS the behavioural
 * contract: 7 of 16 map to a named type (Weekly and Bookable each match BOTH
 * their `dated` states, since `dated` is ignored for daily signatures), the
 * other 9 are Custom. */
const INFERENCE_TABLE: ReadonlyArray<{
  dims: Dimensions;
  expected: TemplateId | null;
}> = [
  // Standard (daily = false): splits on (dated, purchaseable, logistics).
  { dims: d(false, false, false, false), expected: null },
  { dims: d(false, false, false, true), expected: null },
  { dims: d(false, false, true, false), expected: "online-digital" },
  { dims: d(false, false, true, true), expected: "delivered-item" },
  { dims: d(false, true, false, false), expected: "one-off-event" },
  { dims: d(false, true, false, true), expected: null },
  { dims: d(false, true, true, false), expected: null },
  { dims: d(false, true, true, true), expected: null },
  // Daily (daily = true): `dated` is ignored, so each named daily type appears twice.
  { dims: d(true, false, false, false), expected: "weekly-event" },
  { dims: d(true, false, false, true), expected: null },
  { dims: d(true, false, true, false), expected: null },
  { dims: d(true, false, true, true), expected: "bookable-item" },
  { dims: d(true, true, false, false), expected: "weekly-event" },
  { dims: d(true, true, false, true), expected: null },
  { dims: d(true, true, true, false), expected: null },
  { dims: d(true, true, true, true), expected: "bookable-item" },
];

function d(
  daily: boolean,
  dated: boolean,
  purchaseable: boolean,
  logistics: boolean,
): Dimensions {
  return { daily, dated, logistics, purchaseable };
}

describe("listing-templates", () => {
  describe("dimensionsOf", () => {
    test("maps each stored field to its dimension", () => {
      expect(
        dimensionsOf({
          date: "2026-01-01T00:00:00Z",
          listing_type: "daily",
          purchase_only: true,
          uses_logistics: true,
        }),
      ).toEqual({
        daily: true,
        dated: true,
        logistics: true,
        purchaseable: true,
      });
    });

    test("reads the false/empty side of every dimension", () => {
      expect(
        dimensionsOf({
          date: "",
          listing_type: "standard",
          purchase_only: false,
          uses_logistics: false,
        }),
      ).toEqual({
        daily: false,
        dated: false,
        logistics: false,
        purchaseable: false,
      });
    });

    test("daily is true only for listing_type 'daily'", () => {
      expect(dimensionsOf(sourceOf(d(true, false, false, false))).daily).toBe(
        true,
      );
      expect(dimensionsOf(sourceOf(d(false, false, false, false))).daily).toBe(
        false,
      );
    });
  });

  describe("matchesSignature", () => {
    test("requires every named dimension to agree", () => {
      const sig = {
        daily: false,
        dated: true,
        logistics: false,
        purchaseable: false,
      };
      expect(matchesSignature(sig, d(false, true, false, false))).toBe(true);
      expect(matchesSignature(sig, d(false, true, false, true))).toBe(false);
      expect(matchesSignature(sig, d(false, true, true, false))).toBe(false);
      expect(matchesSignature(sig, d(true, true, false, false))).toBe(false);
    });

    test("an absent `dated` matches either dated state (daily signatures)", () => {
      const dailySig = { daily: true, logistics: false, purchaseable: false };
      expect(matchesSignature(dailySig, d(true, false, false, false))).toBe(
        true,
      );
      expect(matchesSignature(dailySig, d(true, true, false, false))).toBe(
        true,
      );
    });

    test("a present `dated` is enforced (standard signatures)", () => {
      const sig = {
        daily: false,
        dated: false,
        logistics: false,
        purchaseable: true,
      };
      expect(matchesSignature(sig, d(false, false, true, false))).toBe(true);
      expect(matchesSignature(sig, d(false, true, true, false))).toBe(false);
    });
  });

  describe("inferTemplate", () => {
    test("maps every dimension combination to its expected template", () => {
      for (const { dims, expected } of INFERENCE_TABLE) {
        const got = inferTemplate(sourceOf(dims))?.id ?? null;
        expect(got).toBe(expected);
      }
    });

    test("exactly 7 of the 16 combinations match a named template", () => {
      const matched = INFERENCE_TABLE.filter((r) => r.expected !== null);
      expect(matched.length).toBe(7);
      expect(INFERENCE_TABLE.length - matched.length).toBe(9);
    });

    test("no combination matches more than one template (exclusivity)", () => {
      for (const { dims } of INFERENCE_TABLE) {
        const matches = LISTING_TEMPLATES.filter((t) =>
          matchesSignature(t.signature, dims),
        );
        expect(matches.length).toBeLessThanOrEqual(1);
      }
    });

    test("Weekly and Bookable each match both dated states", () => {
      expect(inferTemplate(sourceOf(d(true, false, false, false)))?.id).toBe(
        "weekly-event",
      );
      expect(inferTemplate(sourceOf(d(true, true, false, false)))?.id).toBe(
        "weekly-event",
      );
      expect(inferTemplate(sourceOf(d(true, false, true, true)))?.id).toBe(
        "bookable-item",
      );
      expect(inferTemplate(sourceOf(d(true, true, true, true)))?.id).toBe(
        "bookable-item",
      );
    });

    test("price does not affect the inferred type", () => {
      const free = testListing({ date: "2026-01-01T00:00:00Z" });
      const paid = testListing({
        can_pay_more: true,
        date: "2026-01-01T00:00:00Z",
        unit_price: 1500,
      });
      // Both are standard + dated + check-in (purchase_only=false) + no-logistics.
      expect(inferTemplate(free)?.id).toBe("one-off-event");
      expect(inferTemplate(paid)?.id).toBe("one-off-event");
    });

    test("returns null (Custom) for an unmatched shape", () => {
      // standard, no-date, check-in, logistics — not one of the five.
      expect(inferTemplate(sourceOf(d(false, false, false, true)))).toBeNull();
    });
  });

  describe("template flags", () => {
    test("only the one-off template requires a date", () => {
      const requiring = LISTING_TEMPLATES.filter((t) => t.requiresDate).map(
        (t) => t.id,
      );
      expect(requiring).toEqual([ONE_OFF_TEMPLATE_ID]);
    });

    test("exactly the logistics templates require the logistics feature", () => {
      const requiring = LISTING_TEMPLATES.filter(
        (t) => t.requiresLogistics,
      ).map((t) => t.id);
      expect(requiring).toEqual(["delivered-item", "bookable-item"]);
    });
  });

  describe("submissionRequiresDate", () => {
    const oneOffShape = d(false, false, false, false);

    test("requires a date for a one-off-shaped one-off submission", () => {
      expect(submissionRequiresDate(ONE_OFF_TEMPLATE_ID, oneOffShape)).toBe(
        true,
      );
    });

    test("ignores the submitted `dated` value itself", () => {
      // dated is irrelevant to the predicate — it reads only daily/purchaseable/logistics.
      expect(
        submissionRequiresDate(
          ONE_OFF_TEMPLATE_ID,
          d(false, true, false, false),
        ),
      ).toBe(true);
    });

    test("does not require a date once a dimension is changed away from one-off", () => {
      expect(
        submissionRequiresDate(
          ONE_OFF_TEMPLATE_ID,
          d(true, false, false, false),
        ),
      ).toBe(false);
      expect(
        submissionRequiresDate(
          ONE_OFF_TEMPLATE_ID,
          d(false, false, true, false),
        ),
      ).toBe(false);
      expect(
        submissionRequiresDate(
          ONE_OFF_TEMPLATE_ID,
          d(false, false, false, true),
        ),
      ).toBe(false);
    });

    test("does not require a date when the chosen template is not the one-off", () => {
      // The Custom card posting the same one-off-shaped non-date dims must be allowed.
      expect(submissionRequiresDate("custom", oneOffShape)).toBe(false);
      expect(submissionRequiresDate(null, oneOffShape)).toBe(false);
      expect(submissionRequiresDate("online-digital", oneOffShape)).toBe(false);
    });
  });
});
