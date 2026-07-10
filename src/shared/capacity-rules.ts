/**
 * Capacity rules — the single declarative table of which capacity checks
 * apply to which kind of listing.
 *
 * Capacity is enforced in several places: the JS preflight
 * (`#shared/db/attendees/capacity.ts`), the inline SQL guard embedded in the
 * booking INSERT/UPDATE (`#shared/db/capacity.ts`), and the booking-page
 * limits (`#shared/booking/model.ts`, `#shared/booking/package-cap.ts`).
 * Each of those used to branch on `listing_type === "daily"` by hand. This
 * table is the one reference they all consult instead: every rule declares
 * which listings it applies to, and both the JS branches and the SQL
 * fragments derive from the same declaration — so the preflight and the
 * write-time guard can never disagree about which check applies.
 *
 * This module is pure: it declares rules and derives answers from them, and
 * never touches the database.
 */

import { type ListingType, ListingTypeSchema } from "#shared/types.ts";

/** The two listing facts that decide which capacity checks apply. */
export type CapacityFacet = {
  listing_type: ListingType;
  customisable_days: boolean;
};

/** Every capacity check the system can apply to a booking. */
export type CapacityRuleKey =
  | "dateLessCap"
  | "perDateCap"
  | "groupPoolCap"
  | "parentChildUnits"
  | "adminOverbookBypass";

/** One capacity check plus the listings it applies to. */
export type CapacityRule = {
  key: CapacityRuleKey;
  /** Keeps only the listings this check applies to. */
  appliesTo: (facet: CapacityFacet) => boolean;
};

/** A daily listing's spots are counted for each date it occupies. */
const bookedPerDate = (facet: CapacityFacet): boolean =>
  facet.listing_type === "daily";

/** Every listing, whatever its facets. */
const everyListing = (): boolean => true;

/**
 * A listing's own cap (`listings.max_attendees`) is counted exactly one of
 * two ways — every facet must have exactly one of `dateLessCap`/`perDateCap`.
 * A facet with both would double-check (and double-count) the same cap; a
 * facet with neither would have no own-cap check at all. Exported so the
 * invariant is unit-testable; runs once when this module loads.
 */
export const assertOneOwnCapRule = (
  rules: readonly CapacityRule[],
): readonly CapacityRule[] => {
  for (const facet of allCapacityFacets()) {
    const counting = rules.filter(
      (rule) =>
        (rule.key === "dateLessCap" || rule.key === "perDateCap") &&
        rule.appliesTo(facet),
    );
    if (counting.length !== 1) {
      throw new Error(
        `A ${facet.listing_type} listing (customisable_days: ${facet.customisable_days}) ` +
          `must have exactly one own-cap counting rule, found ${counting.length}`,
      );
    }
  }
  return rules;
};

/** Every combination of the capacity facets. */
export const allCapacityFacets = (): CapacityFacet[] =>
  ListingTypeSchema.options.flatMap((listing_type) =>
    [false, true].map((customisable_days) => ({
      customisable_days,
      listing_type,
    })),
  );

/**
 * The capacity checks, in the order a booking meets them. Each entry says in
 * plain words what the check protects and which listings it applies to; the
 * enforcement sites named per entry all consult this table rather than
 * re-deciding by hand.
 */
export const CAPACITY_RULES: readonly CapacityRule[] = assertOneOwnCapRule([
  /**
   * dateLessCap — the listing's own `max_attendees` cap, counted as ONE
   * running total across all its bookings (`listings.booked_quantity`).
   * Applies to standard listings: their rows carry no booking range, so a
   * date can never change what "full" means. Counted by
   * `buildListingCountSql` (SQL) and the date-less remaining lookups (JS).
   */
  { appliesTo: (facet) => !bookedPerDate(facet), key: "dateLessCap" },
  /**
   * perDateCap — the listing's own `max_attendees` cap, counted PER DATE by
   * summing the rows whose [start, end) range covers that date. Applies to
   * daily listings: a multi-day booking must fit EVERY day it occupies, and
   * spots freed on one date say nothing about another. Counted by
   * `buildListingCountSql` (SQL) and the per-day expansion in
   * `#shared/db/attendees/capacity.ts` (JS). A daily listing therefore has
   * NO date-less own count — date-less surfaces must not treat its running
   * total as remaining stock.
   */
  { appliesTo: bookedPerDate, key: "perDateCap" },
  /**
   * groupPoolCap — a capped group's `max_attendees` is a pool shared by every
   * member listing's bookings. Applies to every listing; each member's
   * bookings drain the pool the way its own cap counts them (running total
   * for `dateLessCap` members, per-date for `perDateCap` members), so a
   * date-less pool read includes only `dateLessCap` members. Enforced by the
   * NOT EXISTS group clause in `buildDayCapacitySql` (SQL) and the
   * `getGroupRemaining*` lookups (JS).
   */
  { appliesTo: everyListing, key: "groupPoolCap" },
  /**
   * parentChildUnits — a parent and its required child booked together each
   * take a spot in any capped group they share, so one combined order needs
   * `PARENT_CHILD_GROUP_UNITS` free spots there. Applies to every listing;
   * enforced by `parentAndChildFitGroup` and the `ticketsThatFitInPool`
   * ceilings in `#shared/booking/package-cap.ts`.
   */
  { appliesTo: everyListing, key: "parentChildUnits" },
  /**
   * adminOverbookBypass — an admin manually adding or editing a booking may
   * deliberately exceed every cap above. Applies to every listing; wired as
   * the `allowOverbook` flag on `buildCapacityCheckedInsert` and the
   * attendee create/update/servicing writers.
   */
  { appliesTo: everyListing, key: "adminOverbookBypass" },
]);

const ruleByKey = new Map(CAPACITY_RULES.map((rule) => [rule.key, rule]));

/** The capacity checks that apply to a listing. */
export const applicableCapacityRules = (
  facet: CapacityFacet,
): ReadonlySet<CapacityRuleKey> =>
  new Set(
    CAPACITY_RULES.filter((rule) => rule.appliesTo(facet)).map(
      (rule) => rule.key,
    ),
  );

/** Curried: does this capacity check apply to this listing? */
export const hasCapacityRule =
  (key: CapacityRuleKey) =>
  (facet: CapacityFacet): boolean =>
    ruleByKey.get(key)!.appliesTo(facet);

/**
 * The listing types a rule applies to, for consumers that only see a
 * `listing_type` — narrow query rows, and the SQL guard (which can only read
 * the `listing_type` column). A rule whose customisable-days variants
 * disagree cannot be keyed by listing type alone, so this throws rather than
 * silently ignoring the distinction. Curried so the throw is testable with a
 * bad table; production callers use {@link listingTypesWithRule}.
 */
export const listingTypesWithRuleIn =
  (rules: readonly CapacityRule[]) =>
  (key: CapacityRuleKey): ListingType[] => {
    const rule = rules.find((candidate) => candidate.key === key)!;
    return ListingTypeSchema.options.filter((listing_type) => {
      const [plain, customisable] = [false, true].map((customisable_days) =>
        rule.appliesTo({ customisable_days, listing_type }),
      );
      if (plain !== customisable) {
        throw new Error(
          `Capacity rule "${key}" depends on customisable_days, so it cannot ` +
            "be keyed by listing type alone",
        );
      }
      return plain!;
    });
  };

export const listingTypesWithRule = listingTypesWithRuleIn(CAPACITY_RULES);

/**
 * SQL predicate matching the listing types a rule applies to, e.g.
 * `listing.listing_type IN ('daily')`. The shared bridge between this table
 * and the inline SQL guard: the guard interpolates these fragments instead of
 * hardcoding type literals, so it enforces the same declaration the JS
 * preflight reads. Types come from our own picklist, never user input.
 * Curried so the no-matching-type error is testable with a bad table;
 * production callers use {@link capacityRuleTypeSql}.
 */
export const capacityRuleTypeSqlIn =
  (rules: readonly CapacityRule[]) =>
  (key: CapacityRuleKey, column: string): string => {
    const types = listingTypesWithRuleIn(rules)(key);
    if (types.length === 0) {
      throw new Error(
        `Capacity rule "${key}" applies to no listing type, so it has no SQL predicate`,
      );
    }
    return `${column} IN (${types.map((type) => `'${type}'`).join(", ")})`;
  };

export const capacityRuleTypeSql = capacityRuleTypeSqlIn(CAPACITY_RULES);

const perDateTypes = listingTypesWithRule("perDateCap");

/**
 * Whether a listing type's own cap is counted per occupied date
 * (`perDateCap`) rather than as one running total (`dateLessCap`). Because
 * every facet has exactly one counting rule ({@link assertOneOwnCapRule}),
 * `false` always means the running total applies.
 */
export const countsPerDate = (listingType: ListingType): boolean =>
  perDateTypes.includes(listingType);

/**
 * The date a capacity check actually uses: a `perDateCap` listing keeps the
 * booking's date, a `dateLessCap` listing drops it — its rows carry no
 * booking range, so a date filter would never match them and its cap must be
 * counted as the running total instead.
 */
export const capacityDateFor = (
  listingType: ListingType,
  date: string | null | undefined,
): string | null => (countsPerDate(listingType) ? (date ?? null) : null);
