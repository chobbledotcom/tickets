/** The stored column of each field kind, so a table declares its fields once
 *  as a field list. */

import * as v from "valibot";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import type { DecryptFn, EncryptFn } from "#db/common-schema.ts";
import { type ColumnDef, col } from "#db/table.ts";
import { storedListingFields } from "#shared/listing-fields.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  type ByFieldKind,
  byFieldKind,
  type FieldKind,
  type FieldSpec,
  type FieldSpecs,
  type StoredValue,
} from "#shared/rest/field-specs.ts";
import { clampDurationDays, DayPricesSchema, type ListingType } from "#types";

/** What a kind's column builder reads: the field, its table's name for
 *  error context, and the table's encryption pair. */
type ColumnContext = {
  decrypt: DecryptFn;
  encrypt: EncryptFn;
  field: FieldSpec;
  table: string;
};

const TZ_SUFFIX_REGEX = /(?:Z|[+-]\d{2}:\d{2})$/i;

/** A stored datetime as a UTC ISO text. A value without an offset is read as
 *  UTC, and the gap is logged. */
const normalizeUtcDatetime = (value: string, label: string): string => {
  if (value === "") return "";
  let normalized = value;
  if (!TZ_SUFFIX_REGEX.test(value)) {
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

/** The encrypted datetime pair of one column. */
type DatetimePair = {
  read: (value: EnvKeyEncrypted) => Promise<string>;
  write: (value: string) => Promise<EnvKeyEncrypted>;
};

/** A datetime column, built from the encrypted pair of its field. */
const datetimeColumn =
  <Value>(build: (pair: DatetimePair) => ColumnDef<Value>) =>
  ({ decrypt, encrypt, field }: ColumnContext): ColumnDef<Value> =>
    build({
      read: async (value) =>
        normalizeUtcDatetime(await decrypt(value), "stored datetime"),
      write: (value) => encrypt(normalizeUtcDatetime(value, field.key)),
    });

/** The label a JSON column names in an invalid-value error. */
const jsonLabel = ({ field, table }: ColumnContext): string =>
  `${table}.${field.key}`;

/** A column whose default is the field's declared default. */
const declaredDefault = <Value>(field: FieldSpec): ColumnDef<Value> =>
  field.default === undefined
    ? col.simple<Value>()
    : // The field list declares a default of its own kind.
      col.withDefault(() => field.default as Value);

/** A column with the field's declared default that tidies every write. */
const tidiedOnWrite =
  <Value>(write: (value: Value) => Value) =>
  ({ field }: ColumnContext): ColumnDef<Value> => ({
    ...declaredDefault<Value>(field),
    write,
  });

/** A table's columns, built once its encryption pair is known. */
type SealedColumns<Columns> = (
  encrypt: EncryptFn,
  decrypt: DecryptFn,
) => Columns;

/** The stored column each field kind gives. */
type KindColumns = { [Kind in FieldKind]: ColumnDef<StoredValue[Kind]> };

/** The stored column of each field kind. A name and private text are
 *  encrypted. The counts, prices, switches, and dates stay plaintext, so SQL
 *  can order and filter by them. */
const KIND_COLUMNS: {
  [Kind in FieldKind]: (context: ColumnContext) => KindColumns[Kind];
} = {
  // Every write stores the parser's own read of the string. The stored tokens
  // are what every reader compares: the booking form and the badge SQL alike.
  contactFields: tidiedOnWrite(storedListingFields),
  count: ({ field }) => declaredDefault<number>(field),
  date: () => col.simple<string>(),
  datetime: datetimeColumn(({ read, write }) => ({
    default: () => "",
    ...col.encrypted(write, read),
  })),
  dayPrices: (context) =>
    col.json(DayPricesSchema, {
      context: jsonLabel(context),
      projected: true,
      whenMissing: () => ({}),
    }),
  durationDays: tidiedOnWrite(clampDurationDays),
  listingType: ({ field }) => declaredDefault<ListingType>(field),
  name: ({ decrypt, encrypt }) => col.encrypted(encrypt, decrypt),
  optionalDatetime: datetimeColumn(({ read, write }) =>
    col.transform<string | null>(
      // The table skips write transforms for null values.
      (value) => write(value as string),
      // The column is NOT NULL and always stores ciphertext. An empty time
      // reads as no time.
      async (value) => {
        const result = await read(value as EnvKeyEncrypted);
        return result === "" ? null : result;
      },
    ),
  ),
  price: ({ field }) => declaredDefault<number>(field),
  privateText: ({ decrypt, encrypt }) => col.encryptedText(encrypt, decrypt),
  switch: ({ field }) => col.boolean(field.default === true),
  text: () => col.simple<string>(),
  weekdays: (context) =>
    col.json(v.array(v.string()), {
      context: jsonLabel(context),
      // The field list declares the weekday names as the default.
      default: () => [...(context.field.default as readonly string[])],
    }),
};

/** The columns one field declaration stores in the named table. */
export const fieldColumns =
  <const Fields extends FieldSpecs>(
    table: string,
    fields: Fields,
  ): SealedColumns<ByFieldKind<Fields, KindColumns>> =>
  (encrypt, decrypt) =>
    byFieldKind<Fields, KindColumns>(fields, (field) =>
      KIND_COLUMNS[field.kind]({ decrypt, encrypt, field, table }),
    );

/** Add the generated id column to a table's columns. */
const withGeneratedId =
  <Columns>(
    columns: SealedColumns<Columns>,
  ): SealedColumns<Columns & { id: ColumnDef<number> }> =>
  (encrypt, decrypt) => ({
    id: col.generated<number>(),
    ...columns(encrypt, decrypt),
  });

/** The columns one field declaration stores, with a generated id. */
export const fieldColumnsWithId = <const Fields extends FieldSpecs>(
  table: string,
  fields: Fields,
) => withGeneratedId(fieldColumns(table, fields));
