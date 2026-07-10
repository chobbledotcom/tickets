import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  allCapacityFacets,
  applicableCapacityRules,
  assertCapacityRulesCoherent,
  CAPACITY_RULES,
  type CapacityRule,
  capacityDateFor,
  capacityRuleTypeSql,
  countsPerDate,
  hasDateLessCap,
  listingTypesWithRule,
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

  describe("hasDateLessCap", () => {
    test("true exactly for the facets carrying the dateLessCap rule", () => {
      for (const facet of allCapacityFacets()) {
        expect(hasDateLessCap(facet)).toBe(facet.listing_type === "standard");
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
      expect(() => listingTypesWithRule("perDateCap", rules)).toThrow(
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
  });

  describe("assertCapacityRulesCoherent", () => {
    test("accepts the production table unchanged", () => {
      expect(assertCapacityRulesCoherent(CAPACITY_RULES)).toBe(CAPACITY_RULES);
    });

    test("rejects a table where a listing would be counted twice", () => {
      const both: CapacityRule[] = [
        { appliesTo: () => true, key: "dateLessCap" },
        { appliesTo: () => true, key: "perDateCap" },
      ];
      expect(() => assertCapacityRulesCoherent(both)).toThrow(
        "exactly one own-cap counting rule, found 2",
      );
    });

    test("rejects a table where a listing would never be counted", () => {
      const neither: CapacityRule[] = [
        { appliesTo: () => true, key: "groupPoolCap" },
      ];
      expect(() => assertCapacityRulesCoherent(neither)).toThrow(
        "exactly one own-cap counting rule, found 0",
      );
    });

    test("rejects a rule no listing can ever match", () => {
      const withDeadRule: CapacityRule[] = [
        { appliesTo: () => true, key: "dateLessCap" },
        { appliesTo: () => false, key: "groupPoolCap" },
      ];
      expect(() => assertCapacityRulesCoherent(withDeadRule)).toThrow(
        'Capacity rule "groupPoolCap" applies to no listing',
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
