// effects: pure
/**
 * How the stored value of a column becomes the value that the code uses, and
 * back. `#db/codecs/columns.ts` gives each column its codec once. A typed read
 * decodes the columns it picks, and `encoded` turns new values into stored
 * ones before a write.
 */

import type { InValue } from "@libsql/client";
import type * as v from "valibot";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

declare const STORED: unique symbol;

/** A column that the code reads and writes as `App`. `rowId` names the row in
 *  a read error. */
export type Codec<Stored extends InValue, App> = Readonly<{
  decode: (stored: Stored, rowId: unknown) => App | Promise<App>;
  encode: (app: App) => Stored | Promise<Stored>;
}>;

/** A column whose stored value has a narrower type than its SQL type. The
 *  value comes from a fixed list, or is text sealed under the owner key that
 *  code opens late with the owner's key. Nothing runs on a read or a write. */
export type Typed<Stored extends InValue> = Readonly<{
  readonly [STORED]: Stored;
}>;

/** The codec of any column. */
export type ColumnCodec = Codec<any, any> | Typed<any>;

/** The stored type of a codec. */
export type StoredOf<Column> =
  Column extends Codec<infer Stored, infer _App>
    ? Stored
    : Column extends Typed<infer Stored>
      ? Stored
      : never;

/** The type that the code reads from a column with this codec. */
export type AppOf<Column> =
  Column extends Codec<infer _Stored, infer App>
    ? App
    : Column extends Typed<infer Stored>
      ? Stored
      : never;

/** A column that stores `Stored`. The type exists only for the compiler. */
export const typed = <Stored extends InValue>(): Typed<Stored> =>
  ({}) as Typed<Stored>;

/** Whether a codec runs code on a read and a write. */
export const converts = (
  codec: ColumnCodec,
): codec is Codec<InValue, unknown> => "decode" in codec;

/** The same codec over a column that can hold nothing. */
export const nullable = <Stored extends InValue, App>(
  codec: Codec<Stored, App>,
): Codec<Stored | null, App | null> => ({
  decode: (stored, rowId) =>
    stored === null ? null : codec.decode(stored, rowId),
  encode: (app) => (app === null ? null : codec.encode(app)),
});

/** The same codec over text that stores blank as itself. */
export const blankAsItself = <Stored extends string>(
  codec: Codec<Stored, string>,
): Codec<Stored | "", string> => ({
  decode: (stored, rowId) => (stored === "" ? "" : codec.decode(stored, rowId)),
  encode: (app) => (app === "" ? "" : codec.encode(app)),
});

/** A yes or no, stored as 1 or 0. */
export const yesNo: Codec<number, boolean> = {
  decode: (stored) => stored === 1,
  encode: (app) => (app ? 1 : 0),
};

/** A value stored as JSON text, checked against `schema` both ways. */
export const json = <Schema extends v.GenericSchema>(
  schema: Schema,
  context: string,
): Codec<string, v.InferOutput<Schema>> => {
  const stored = defineStoredJson(schema);
  return {
    decode: (text, rowId) => stored.read(text, `${context} row ${rowId}`),
    encode: (app) => stored.write(app, context),
  };
};

/** A codec that runs `tidy` on each new value before `codec` stores it. */
export const tidied = <Stored extends InValue, App>(
  codec: Codec<Stored, App>,
  tidy: (app: App) => App,
): Codec<Stored, App> => ({
  decode: codec.decode,
  encode: (app) => codec.encode(tidy(app)),
});

/** A value stored as it is. */
export const asItself = <Value extends InValue>(): Codec<Value, Value> => ({
  decode: (stored) => stored,
  encode: (app) => app,
});
