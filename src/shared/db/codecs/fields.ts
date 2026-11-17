/**
 * The codec of each field kind, so a table whose columns come from a field
 * list declares its codecs once, as that list.
 */

import * as v from "valibot";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import {
  asItself,
  blankAsItself,
  type Codec,
  json,
  type Typed,
  tidied,
  typed,
  yesNo,
} from "#db/codecs/kinds.ts";
import { columnName } from "#shared/column-names.ts";
import { storedListingFields } from "#shared/listing-fields.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type {
  ByColumn,
  FieldKind,
  FieldSpec,
  FieldSpecs,
} from "#shared/rest/field-specs.ts";
import type { RecurringIntervalChoice } from "#shared/subscriptions/plan.ts";
import {
  clampDurationDays,
  type ListingFields,
  type ListingType,
} from "#types";

/** Text sealed under the env key. */
export const sealed: Codec<EnvKeyEncrypted, string> = {
  decode: (stored) => decrypt(stored),
  encode: (app) => encrypt(app),
};

const TZ_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/i;

/** A stored datetime as a UTC ISO text. A value without an offset is read as
 *  UTC, and the gap is logged. */
export const normalizeUtcDatetime = (value: string, label: string): string => {
  if (value === "") return "";
  let normalized = value;
  if (!TZ_SUFFIX.test(value)) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `${label} missing timezone offset (${value})`,
    });
    normalized = `${value}Z`;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} has invalid datetime: ${value}`);
  }
  return date.toISOString();
};

/** A sealed datetime: tidied to UTC both ways. */
const sealedDatetime = (field: FieldSpec): Codec<EnvKeyEncrypted, string> => ({
  decode: async (stored) =>
    normalizeUtcDatetime(await decrypt(stored), "stored datetime"),
  encode: (app) => encrypt(normalizeUtcDatetime(app, columnName(field.key))),
});

/** The codec each field kind gives. A kind with no column of its own has
 *  none. */
type KindCodecs = {
  contactFields: Codec<ListingFields, ListingFields>;
  count: Typed<number>;
  date: Typed<string>;
  datetime: Codec<EnvKeyEncrypted, string>;
  dayPrices: undefined;
  durationDays: Codec<number, number>;
  listingType: Typed<ListingType>;
  name: Codec<EnvKeyEncrypted, string>;
  optionalDatetime: Codec<EnvKeyEncrypted, string | null>;
  price: Typed<number>;
  privateText: Codec<EnvKeyEncrypted | "", string>;
  recurringInterval: Typed<RecurringIntervalChoice>;
  switch: Codec<number, boolean>;
  text: Typed<string>;
  weekdays: Codec<string, string[]>;
};

const KIND_CODECS: {
  [Kind in FieldKind]: (field: FieldSpec, table: string) => KindCodecs[Kind];
} = {
  // Every write stores the parser's own read of the string. The stored tokens
  // are what every reader compares: the booking form and the badge SQL alike.
  contactFields: () => tidied(asItself<ListingFields>(), storedListingFields),
  count: () => typed(),
  date: () => typed(),
  datetime: sealedDatetime,
  dayPrices: () => undefined,
  durationDays: () => tidied(asItself<number>(), clampDurationDays),
  listingType: () => typed(),
  name: () => sealed,
  optionalDatetime: (field) => {
    const datetime = sealedDatetime(field);
    // The column always stores ciphertext. An empty time reads as no time.
    return {
      decode: async (stored, rowId) =>
        (await datetime.decode(stored, rowId)) || null,
      encode: (app) => datetime.encode(app ?? ""),
    };
  },
  price: () => typed(),
  privateText: () => blankAsItself(sealed),
  recurringInterval: () => typed(),
  switch: () => yesNo,
  text: () => typed(),
  weekdays: (field, table) =>
    json(v.array(v.string()), `${table}.${columnName(field.key)}`),
};

/** The codec of each stored field of a list, keyed by its column. */
export type FieldCodecs<Fields extends FieldSpecs> = ByColumn<
  Fields,
  KindCodecs,
  "dayPrices"
>;

/** The codecs of a field list, stored in `table`. */
export const fieldCodecs = <const Fields extends FieldSpecs>(
  table: string,
  fields: Fields,
): FieldCodecs<Fields> =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const codec = KIND_CODECS[field.kind](field, table);
      return codec === undefined ? [] : [[columnName(field.key), codec]];
    }),
  ) as FieldCodecs<Fields>;
