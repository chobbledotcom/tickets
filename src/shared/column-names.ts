// effects: pure
import * as v from "valibot";

// valibot's word-splitting handles digits and acronyms. The schema is built
// once at module load.
const camelCaseSchema = v.pipe(v.string(), v.toCamelCase());

/** Convert snake_case to camelCase: `max_attendees` becomes `maxAttendees`. */
export const toCamelCase = (s: string): string => v.parse(camelCaseSchema, s);

/** A column name as the code names it: `min_visits` becomes `minVisits`. */
type CamelWord<Name extends string> = Name extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelWord<Tail>>}`
  : Name;

/** A code name as the column names it: `minVisits` becomes `min_visits`. */
type SnakeWord<Name extends string> = Name extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${SnakeWord<Tail>}`
  : Name;

/** A row with each key as the code names it. */
export type CamelCased<Row> = {
  [Key in keyof Row & string as CamelWord<Key>]: Row[Key];
};

/** A record with each key as the column names it. */
export type SnakeCased<Input> = {
  [Key in keyof Input & string as SnakeWord<Key>]: Input[Key];
};

/** The same values under keys that `rename` gives. */
const renamedKeys = (
  record: object,
  rename: (key: string) => string,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [rename(key), value]),
  );

/** A row with each key as the code names it. Each word after an underscore
 *  starts with a capital letter. */
export const camelCaseKeys = <Row extends object>(row: Row): CamelCased<Row> =>
  renamedKeys(row, (key) =>
    key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
  ) as CamelCased<Row>;

/** A record with each key as the column names it. Each capital letter becomes
 *  an underscore and the small letter. */
export const snakeCaseKeys = <Input extends object>(
  input: Input,
): SnakeCased<Input> =>
  renamedKeys(input, (key) =>
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  ) as SnakeCased<Input>;
