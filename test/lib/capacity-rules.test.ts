import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  allCapacityFacets,
  applicableCapacityRules,
  assertOneOwnCapRule,
  CAPACITY_RULES,
  type CapacityRule,
  capacityDateFor,
  capacityRuleTypeSql,
  capacityRuleTypeSqlIn,
  countsPerDate,
  hasCapacityRule,
  listingTypesWithRule,
  listingTypesWithRuleIn,
} from "#shared/capacity-rules.ts";

/** The checks that apply to every listing, whatever its facets. */
const UNIVERSAL = [
  "groupPoolCap",
  "parentChildUnits",
  "adminOverbookBypass",
] as const;

describe("capacity rules", () => {
  describe("applicableCapacityRules", () => {
    test("a standard listing counts its own cap as one running total", () => {
      for (const customisable_days of [false, true]) {
        expect(
          applicableCapacityRules({
            customisable_days,
            listing_type: "standard",
          }),
        ).toEqual(new Set(["dateLessCap", ...UNIVERSAL]));
      }
    });

    test("a daily listing counts its own cap per occupied date", () => {
      for (const customisable_days of [false, true]) {
        expect(
          applicableCapacityRules({ customisable_days, listing_type: "daily" }),
        ).toEqual(new Set(["perDateCap", ...UNIVERSAL]));
      }
    });
  });

  describe("hasCapacityRule", () => {
    const standard = {
      customisable_days: false,
      listing_type: "standard",
    } as const;
    const daily = { customisable_days: false, listing_type: "daily" } as const;

    test("the own-cap counting rules split by listing type", () => {
      expect(hasCapacityRule("dateLessCap")(standard)).toBe(true);
      expect(hasCapacityRule("dateLessCap")(daily)).toBe(false);
      expect(hasCapacityRule("perDateCap")(standard)).toBe(false);
      expect(hasCapacityRule("perDateCap")(daily)).toBe(true);
    });

    test("the shared-pool, parent+child, and admin rules apply to every facet", () => {
      for (const facet of allCapacityFacets()) {
        for (const key of UNIVERSAL) {
          expect(hasCapacityRule(key)(facet)).toBe(true);
        }
      }
    });
  });

  describe("countsPerDate", () => {
    test("true only for listing types with the perDateCap rule", () => {
      expect(countsPerDate("daily")).toBe(true);
      expect(countsPerDate("standard")).toBe(false);
    });
  });

  describe("capacityDateFor", () => {
    test("a per-date listing keeps the booking's date", () => {
      expect(capacityDateFor("daily", "2026-05-01")).toBe("2026-05-01");
    });

    test("a per-date listing with no date checks date-lessly", () => {
      expect(capacityDateFor("daily", null)).toBe(null);
      expect(capacityDateFor("daily", undefined)).toBe(null);
    });

    test("a running-total listing always drops the date", () => {
      expect(capacityDateFor("standard", "2026-05-01")).toBe(null);
      expect(capacityDateFor("standard", undefined)).toBe(null);
    });
  });

  describe("listingTypesWithRule", () => {
    test("maps each own-cap rule to its listing types", () => {
      expect(listingTypesWithRule("perDateCap")).toEqual(["daily"]);
      expect(listingTypesWithRule("dateLessCap")).toEqual(["standard"]);
    });

    test("a universal rule maps to every listing type", () => {
      expect(listingTypesWithRule("groupPoolCap")).toEqual([
        "standard",
        "daily",
      ]);
    });

    test("rejects a rule whose applicability depends on customisable days", () => {
      const rules: CapacityRule[] = [
        { appliesTo: (facet) => facet.customisable_days, key: "perDateCap" },
      ];
      expect(() => listingTypesWithRuleIn(rules)("perDateCap")).toThrow(
        "cannot be keyed by listing type alone",
      );
    });
  });

  describe("capacityRuleTypeSql", () => {
    test("emits the type predicate the SQL guard interpolates", () => {
      expect(capacityRuleTypeSql("perDateCap", "listing.listing_type")).toBe(
        "listing.listing_type IN ('daily')",
      );
      expect(
        capacityRuleTypeSql("dateLessCap", "memberListing.listing_type"),
      ).toBe("memberListing.listing_type IN ('standard')");
      expect(capacityRuleTypeSql("groupPoolCap", "t")).toBe(
        "t IN ('standard', 'daily')",
      );
    });

    test("rejects a rule that applies to no listing type", () => {
      const rules: CapacityRule[] = [
        { appliesTo: () => false, key: "perDateCap" },
      ];
      expect(() => capacityRuleTypeSqlIn(rules)("perDateCap", "t")).toThrow(
        "applies to no listing type",
      );
    });
  });

  describe("assertOneOwnCapRule", () => {
    test("accepts the production table unchanged", () => {
      expect(assertOneOwnCapRule(CAPACITY_RULES)).toBe(CAPACITY_RULES);
    });

    test("rejects a table where a listing would be counted twice", () => {
      const both: CapacityRule[] = [
        { appliesTo: () => true, key: "dateLessCap" },
        { appliesTo: () => true, key: "perDateCap" },
      ];
      expect(() => assertOneOwnCapRule(both)).toThrow(
        "exactly one own-cap counting rule, found 2",
      );
    });

    test("rejects a table where a listing would never be counted", () => {
      const neither: CapacityRule[] = [
        { appliesTo: () => true, key: "groupPoolCap" },
      ];
      expect(() => assertOneOwnCapRule(neither)).toThrow(
        "exactly one own-cap counting rule, found 0",
      );
    });
  });

  describe("allCapacityFacets", () => {
    test("covers every listing type × customisable days combination", () => {
      expect(allCapacityFacets()).toEqual([
        { customisable_days: false, listing_type: "standard" },
        { customisable_days: true, listing_type: "standard" },
        { customisable_days: false, listing_type: "daily" },
        { customisable_days: true, listing_type: "daily" },
      ]);
    });
  });
});
