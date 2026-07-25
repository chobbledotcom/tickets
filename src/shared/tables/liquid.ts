/** Render a single column value through a Liquid filter expression.
 *
 *  Moved here from the old `column-order.ts` so the configurable layout
 *  renderer stays pure (no JSX, no table modules). The Liquid engine itself
 *  is the same one `column-order.ts` used: `currency` is the project's
 *  custom filter; `date` is a LiquidJS built-in applied after converting an
 *  ISO string into a Date object.
 *
 *  Pure: takes value + expression, returns a string. */

import { once } from "#fp";
import { createBaseLiquidEngine } from "#shared/liquid-engine.ts";

const getEngine = once(createBaseLiquidEngine);

/** Matches only when `date` is the first filter applied to the raw value.
 *  Converting ISO strings → Date objects is only correct in that case — a
 *  later `| date` (after a string-transforming filter) wants the string. */
const FIRST_FILTER_IS_DATE_RE = /^[^|]*\|\s*date\b/;

/** Render `{{ expression }}` against a context whose only key is the column
 *  key, holding `rawValue` (or a Date when the first filter is `date`). */
export const renderFilteredValue = (
  expression: string,
  rawValue: unknown,
  key: string,
): string => {
  let contextValue = rawValue;
  if (
    typeof rawValue === "string" &&
    FIRST_FILTER_IS_DATE_RE.test(expression)
  ) {
    const d = new Date(rawValue);
    if (!Number.isNaN(d.getTime())) contextValue = d;
  }
  const result = getEngine().parseAndRenderSync(`{{ ${expression} }}`, {
    [key]: contextValue,
  });
  return result.trim();
};
