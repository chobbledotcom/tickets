import { once } from "#fp";
import { createBaseLiquidEngine } from "#shared/liquid-engine.ts";

const getEngine = once(createBaseLiquidEngine);
const FIRST_FILTER_IS_DATE_RE = /^[^|]*\|\s*date\b/;

/** Render a raw value through its saved Liquid expression. A valid date string
 * becomes a Date only when `date` is the first filter in the chain. */
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
    const date = new Date(rawValue);
    if (!Number.isNaN(date.getTime())) contextValue = date;
  }
  return getEngine()
    .parseAndRenderSync(`{{ ${expression} }}`, { [key]: contextValue })
    .trim();
};
