/** The package member override rules: what one `package_price_`,
 *  `package_qty_`, or `package_day_price_` field accepts, and the parse that
 *  folds the accepted fields into the member inputs. Pure data-in/data-out so
 *  the coverage run attributes them from one isolate. */

import { t } from "#i18n";
import type { PackageMemberInput } from "#shared/catalog-fields/fields.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  isValidMemberQuantity,
  wholeNumberValue,
} from "#shared/groups/package-member-values.ts";
import { parseOptionalMinorUnits } from "#shared/validation/money.ts";
import type { DayPrices } from "#types";

/** Parse one package-price input to minor units. The form-level validation
 *  ({@link validatePackageMemberForm}) has already refused a non-numeric or
 *  negative value, so only a blank input falls through to `null` — "no
 *  override; use the listing's own price". An explicit `0` is a real value:
 *  the listing is FREE within this package, distinct from "no override".
 *  {@link parseOptionalMinorUnits} is exactly this optional-field shape
 *  (blank ⇒ unset, never a real 0) and enforces the whole-string,
 *  currency-decimal rule. */
const parsePackagePrice = (raw: string): number | null =>
  parseOptionalMinorUnits(raw);

/** Parse one package-quantity input. The form-level validation
 *  ({@link validatePackageMemberForm}) has already refused a non-digit or
 *  sub-1 value. A blank input is the one legal "no override" form, and a
 *  package always includes at least one of each member. */
const parsePackageQuantity = (raw: string): number => {
  const quantity = wholeNumberValue(raw.trim());
  return quantity ?? 1;
};

/** The per-listing `package_day_price_<listingId>_<n>` inputs folded into
 * each listing's day-price override map. The form-level validation
 * ({@link validatePackageMemberForm}) has already refused a non-numeric or
 * negative input. A blank input contributes nothing: no override for that
 * span, and the listing keeps its own day price. An explicit `0` makes the
 * span free in this package, matching {@link parsePackagePrice}. */
const parseMemberDayPrices = (
  keys: ReadonlySet<string>,
  form: FormParams,
): Map<number, DayPrices> => {
  const byListing = new Map<number, DayPrices>();
  for (const key of keys) {
    const match = /^package_day_price_(\d+)_(\d+)$/.exec(key);
    if (!match) continue;
    const price = parsePackagePrice(form.getString(key));
    if (price === null) continue;
    const listingId = Number(match[1]);
    const dayPrices = byListing.get(listingId) ?? {};
    dayPrices[Number(match[2])] = price;
    byListing.set(listingId, dayPrices);
  }
  return byListing;
};

// The package-member form fields are dynamic: one price and quantity pair
// per member listing, keyed by listing id. The static form schema cannot
// declare them. The save's form-level validation walks them and refuses the
// first malformed one in plain words. Before this check the parse silently
// defaulted a malformed value. A junk price became "no override". A junk
// quantity became 1. A junk day price was dropped.
const PACKAGE_PRICE_KEY = /^package_price_(\d+)$/;
const PACKAGE_QTY_KEY = /^package_qty_(\d+)$/;
const PACKAGE_DAY_PRICE_KEY = /^package_day_price_(\d+)_(\d+)$/;

/** The rule one package day-price field must satisfy: the day count the key
 *  names is a positive safe integer, and the price parses. The API day-price
 *  map applies the same rule to its keys. */
const validMemberDayPrice = (raw: string, key: string): boolean => {
  const day = wholeNumberValue(PACKAGE_DAY_PRICE_KEY.exec(key)?.[2] ?? "");
  return (
    day !== null &&
    Number.isSafeInteger(day) &&
    day >= 1 &&
    parsePackagePrice(raw) !== null
  );
};

/** One member override field family: how to recognise its keys, the rule a
 *  typed value must satisfy, and the message a broken value reports. The
 *  rule sees the whole key. The day-price family checks the day count it
 *  names, the same rule the API day-price map applies to its keys. */
const MEMBER_FORM_FIELDS: readonly {
  key: RegExp;
  message: string;
  valid: (raw: string, key: string) => boolean;
}[] = [
  {
    key: PACKAGE_QTY_KEY,
    message: "error.package_member_quantity",
    valid: (raw) => {
      const quantity = wholeNumberValue(raw);
      return quantity !== null && isValidMemberQuantity(quantity);
    },
  },
  {
    key: PACKAGE_PRICE_KEY,
    message: "error.package_member_price",
    valid: (raw) => parsePackagePrice(raw) !== null,
  },
  {
    key: PACKAGE_DAY_PRICE_KEY,
    message: "error.package_member_day_price",
    valid: validMemberDayPrice,
  },
];

/** The strict form check the package routes run before their parse. Every
 *  package_price_, package_qty_, and package_day_price_ field must hold a
 *  value the member rules accept. Blank stays legal and means "no
 *  override". Returns the first error message, or null. */
export const validatePackageMemberForm = (form: FormParams): string | null => {
  // Turning the package off must always succeed: a malformed leftover member
  // input is about to be discarded, so it cannot block the save.
  if (form.getString("is_package") !== "1") return null;
  for (const [key, raw] of form.entries()) {
    const field = MEMBER_FORM_FIELDS.find((entry) => entry.key.test(key));
    if (field === undefined) continue;
    if (raw.trim() === "") continue;
    if (!field.valid(raw, key)) return t(field.message);
  }
  return null;
};

/** Fold the accepted member fields into the inputs the save writes. A
 *  listing with a price key but no day-price keys keeps `{}` — the listing's
 *  own prices, overridable later per day. */
export const parsePackageMembers = (form: FormParams): PackageMemberInput[] => {
  const members: PackageMemberInput[] = [];
  const keys = new Set(form.keys());
  const dayPricesByListing = parseMemberDayPrices(keys, form);
  for (const key of keys) {
    const match = /^package_price_(\d+)$/.exec(key);
    if (!match) continue;
    const listingId = Number(match[1]);
    const savedDayPrices = dayPricesByListing.get(listingId);
    members.push({
      dayPrices: savedDayPrices === undefined ? {} : savedDayPrices,
      listingId,
      price: parsePackagePrice(form.getString(key)),
      quantity: parsePackageQuantity(
        form.getString(`package_qty_${listingId}`),
      ),
    });
  }
  return members;
};
