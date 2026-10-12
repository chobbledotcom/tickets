/**
 * The built-sites list's sort: what the address bar's `?sort=` names, and the
 * row order each choice means. Pure — the page reads the address, the list
 * handler orders the rows, and the table header renders the links.
 */

import * as v from "valibot";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { sort } from "#fp";
import { compareByName } from "#shared/name-order.ts";
import { guardFor } from "#shared/validation/guard.ts";

export const BuiltSitesSortSchema = v.picklist([
  "name",
  "created",
  "read_only_from",
]);
export type BuiltSitesSort = v.InferOutput<typeof BuiltSitesSortSchema>;

/** Type guard: narrows an arbitrary string to a {@link BuiltSitesSort}. */
export const isBuiltSitesSort = guardFor(BuiltSitesSortSchema);

/** The sort the address names, or `name` when it names none or an unknown
 * one. A pasted address cannot claim an order the list does not offer. */
export const readBuiltSitesSort = (query: URLSearchParams): BuiltSitesSort => {
  const raw = query.get("sort");
  return raw !== null && isBuiltSitesSort(raw) ? raw : "name";
};

/** The deadline's instant in milliseconds, or null when no deadline is set. */
const deadlineInstant = (deadline: string): number | null =>
  deadline === "" ? null : Date.parse(deadline);

/** The deadlines in time order. A site with no deadline sorts after the dated
 * ones. The stored spellings ("…59Z" and "…59.000Z") name the same instant,
 * so equal deadlines reach the name tie-breaker. */
const compareDeadlines = (first: string, second: string): number => {
  const firstInstant = deadlineInstant(first);
  const secondInstant = deadlineInstant(second);
  if (firstInstant === null || secondInstant === null) {
    return firstInstant === secondInstant ? 0 : firstInstant === null ? 1 : -1;
  }
  return firstInstant - secondInstant;
};

/** Order rows by the chosen sort: name A to Z, created newest first, and
 * read-only deadline soonest first. A site with no read-only deadline sorts
 * after the dated ones, and equal keys fall back to the name. */
export const inBuiltSitesOrder =
  (sortOrder: BuiltSitesSort) =>
  (rows: BuiltSite[]): BuiltSite[] =>
    sort<BuiltSite>((first, second) => {
      if (sortOrder === "name") return compareByName(first, second);
      if (sortOrder === "created") {
        return (
          second.created.localeCompare(first.created) ||
          compareByName(first, second)
        );
      }
      return (
        compareDeadlines(first.readOnlyFrom, second.readOnlyFrom) ||
        compareByName(first, second)
      );
    })(rows);
