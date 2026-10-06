/** The strict value rules for one package member — a listing's price
 *  override, its quantity in the package, and its per-day price overrides —
 *  shared by the page form validator and the JSON body parser, so both
 *  surfaces refuse the same facts. */

import type { DayPrices } from "#types";

/** `null` uses the listing price; `0` makes the member free; a positive whole
 *  minor-unit amount overrides it. */
export const isValidMemberPrice = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

/** The units one package grants of this member: a whole number of at least
 *  one. */
export const isValidMemberQuantity = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** Day-count keys are whole numbers of at least one day; values are
 *  non-negative whole minor-unit amounts. */
export const isValidMemberDayPrices = (value: unknown): value is DayPrices =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.entries(value).every(([days, price]) => {
    const day = Number(days);
    return (
      /^\d+$/.test(days) &&
      Number.isSafeInteger(day) &&
      day >= 1 &&
      typeof price === "number" &&
      Number.isSafeInteger(price) &&
      price >= 0
    );
  });
