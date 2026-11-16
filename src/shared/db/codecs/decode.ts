/**
 * Decode the rows of a typed read, and encode new values before a write. A
 * read decodes each value that comes straight from a column with a codec.
 */

import type { InStatement, ResultSet, Row } from "@libsql/client";
import { CODECS } from "#db/codecs/columns.ts";
import { type ColumnCodec, converts } from "#db/codecs/kinds.ts";
import { sourcesOf } from "#db/select/sources.ts";
import type {
  DecodedRowOf,
  RowOf,
  TableHandle,
  TableName,
} from "#db/select/tables.ts";

/** A codec as the runner holds it, whatever its types. */
type Converter = Readonly<{
  decode: (stored: never, rowId: unknown) => unknown;
  encode: (app: never) => unknown;
}>;

const CODEC_TABLES: Readonly<
  Record<string, Readonly<Record<string, ColumnCodec>>>
> = CODECS;

/** The codec that converts a column, or null for a column stored as the code
 *  reads it. */
const converterOrNull = (table: string, column: string): Converter | null => {
  const codec = CODEC_TABLES[table]?.[column];
  return codec !== undefined && converts(codec) ? codec : null;
};

/** One row with each decoded value in place. A null stays null: a left join
 *  with no match has no value to decode. */
const decodeRow = async (
  row: Row,
  decoders: readonly (readonly [string, Converter])[],
): Promise<Row> => {
  const decoded: Record<string, unknown> = { ...row };
  await Promise.all(
    decoders.map(async ([name, codec]) => {
      const stored = row[name];
      if (stored !== null) {
        decoded[name] = await codec.decode(stored as never, row.id);
      }
    }),
  );
  return decoded as Row;
};

/** The result of a statement, with its rows decoded. */
export const decodeResult = async (
  statement: InStatement,
  result: ResultSet,
): Promise<ResultSet> => {
  const decoders = sourcesOf(statement).flatMap(([name, source]) => {
    const codec = converterOrNull(source.table, source.column);
    return codec === null ? [] : [[name, codec] as const];
  });
  if (decoders.length === 0) return result;
  const rows = await Promise.all(
    result.rows.map((row) => decodeRow(row, decoders)),
  );
  return { ...result, rows, toJSON: () => ({ ...result.toJSON(), rows }) };
};

/** The results of a batch, each with its rows decoded. */
export const decodeResults = (
  statements: readonly InStatement[],
  results: readonly ResultSet[],
): Promise<ResultSet[]> =>
  Promise.all(
    results.map((result, index) => decodeResult(statements[index]!, result)),
  );

/** The stored values of some new values, column for column. */
export type Encoded<
  Name extends TableName,
  Values extends Partial<DecodedRowOf<Name>>,
> = {
  readonly [Column in keyof Values]: Column extends keyof RowOf<Name>
    ? RowOf<Name>[Column] | Extract<Values[Column], undefined>
    : never;
};

/** The stored values of some new values. Each column with a codec is encoded,
 *  and the others pass as they are. */
export const encoded = async <
  Name extends TableName,
  const Values extends Partial<DecodedRowOf<Name>>,
>(
  table: TableHandle<Name>,
  values: Values,
): Promise<Encoded<Name, Values>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(values).map(async ([column, value]) => {
        const codec = converterOrNull(table.name, column);
        return [
          column,
          codec === null || value === null || value === undefined
            ? value
            : await codec.encode(value as never),
        ];
      }),
    ),
  ) as Encoded<Name, Values>;
