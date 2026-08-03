import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";

/**
 * The money a payment charge moves, in the smallest unit its currency has
 * (pence, cents). A charge carries an amount that is a non-negative safe whole
 * number and a currency that is three uppercase letters — the one shape every
 * provider's wire response is normalised to at the boundary, so the rest of the
 * payment path never handles a half-parsed amount or a missing currency again.
 */

/** An ISO 4217 currency code, upper-cased. Providers return mixed case
 *  ("gbp", "GBP"); {@link money} canonicalises before this runs. */
const CurrencySchema = v.pipe(
  v.string(),
  v.regex(/^[A-Z]{3}$/u, "Currency must be three uppercase letters"),
);
export type Currency = v.InferOutput<typeof CurrencySchema>;

/** Whether a value is a well-formed currency code. Lets an adapter keep a
 *  malformed provider code away from `Intl` (which throws on one) while still
 *  handing the raw code to {@link money} to be refused. */
export const isCurrency = (value: unknown): value is Currency =>
  v.is(CurrencySchema, value);

/** Money: a non-negative minor-unit amount paired with its currency. The
 *  amount is already in the smallest unit the currency uses, so two amounts in
 *  the same currency can be compared or summed with no conversion. */
const MoneySchema = v.strictObject({
  amount: integerAtLeast(0),
  currency: CurrencySchema,
});
type Money = v.InferOutput<typeof MoneySchema>;

/**
 * Build a {@link Money} from a provider's raw amount and currency, returning
 * `null` when either is malformed: an amount that is not a non-negative safe
 * whole number (a fraction, a negative, `NaN`, `null`), or a currency that is
 * not three letters. The currency is upper-cased first, so a provider's
 * lower-case code ("gbp") is accepted as the canonical "GBP" rather than
 * rejected for its case.
 *
 * The single producer of a `Money` value: every charge the live payment path
 * reads is built here, so a malformed amount or currency is refused once at the
 * boundary instead of leaking into the callbacks as a half-parsed number.
 */
export const money = (amount: unknown, currency: unknown): Money | null => {
  const result = v.safeParse(MoneySchema, {
    amount,
    currency: typeof currency === "string" ? currency.toUpperCase() : currency,
  });
  return result.success ? result.output : null;
};
