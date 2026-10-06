/** The strict value rules for one package member. A member carries a price
 *  override, a quantity in the package, and per-day price overrides. The page
 *  form validator and the JSON body parser share this module, so both
 *  surfaces refuse the same facts. */

/** `null` uses the listing price. `0` makes the member free. A positive whole
 *  minor-unit amount overrides it. */
export const isValidMemberPrice = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

/** The units one package grants of this member: a whole number of at least
 *  one. */
export const isValidMemberQuantity = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** Day-count keys are whole numbers of at least one day. Values are
 *  non-negative whole minor-unit amounts. */
export type MemberDayPricesFault = "days" | "prices";

/** Which part of a day-price map breaks the rule, or null when the whole map
 *  is well-formed. The shape check (object, not array, not null) is the
 *  caller's: the API and the page report it differently. */
export const memberDayPricesFault = (
  value: Record<string, unknown>,
): MemberDayPricesFault | null => {
  const entries = Object.entries(value);
  if (
    entries.some(
      ([days]) =>
        !/^\d+$/.test(days) ||
        Number(days) < 1 ||
        !Number.isSafeInteger(Number(days)),
    )
  ) {
    return "days";
  }
  if (entries.some(([, price]) => !isValidMemberPrice(price))) return "prices";
  return null;
};
