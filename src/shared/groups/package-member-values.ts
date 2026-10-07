/** The strict value rules for one package member. A member carries a price
 *  override, a quantity in the package, and per-day price overrides. The page
 *  form validator and the JSON body parser share this module, so both
 *  surfaces refuse the same facts. */

/** A non-negative whole minor-unit amount. The base both price rules build
 *  on. */
const isWholeAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** `null` uses the listing price. `0` makes the member free. A positive whole
 *  minor-unit amount overrides it. */
export const isValidMemberPrice = (value: unknown): value is number | null =>
  value === null || isWholeAmount(value);

/** The units one package grants of this member: a whole number of at least
 *  one. */
export const isValidMemberQuantity = (value: unknown): value is number =>
  isWholeAmount(value) && value >= 1;

const WHOLE_DIGITS = /^\d+$/;

/** A whole-number form value is plain digits. `1e1`, `0x10`, and `1.5e1` are
 *  not numbers the member rules accept. The day-count keys in a day-price map
 *  share the rule. */
export const wholeNumberValue = (raw: string): number | null => {
  if (!WHOLE_DIGITS.test(raw)) return null;
  return Number(raw);
};

/** Day-count keys are whole numbers of at least one day. Values are
 *  non-negative whole minor-unit amounts. */
export type MemberDayPricesFault = "days" | "prices";

/** Which part of a day-price map breaks the rule, or null when the whole map
 *  is well-formed. The shape check (object, not array, not null) is the
 *  caller's: the API and the page report it differently. A per-day value
 *  cannot be `null`: the map expresses no override for a day by omitting the
 *  day. */
export const memberDayPricesFault = (
  value: Record<string, unknown>,
): MemberDayPricesFault | null => {
  const entries = Object.entries(value);
  if (
    entries.some(
      ([days]) =>
        !WHOLE_DIGITS.test(days) ||
        Number(days) < 1 ||
        !Number.isSafeInteger(Number(days)),
    )
  ) {
    return "days";
  }
  if (entries.some(([, price]) => !isWholeAmount(price))) return "prices";
  return null;
};
