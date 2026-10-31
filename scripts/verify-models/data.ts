import type * as v from "valibot";
import { unique } from "#fp";

type TlaAtom = string | boolean | number;

export type TlaRecord = Readonly<Record<string, TlaAtom>>;
type TlaRecordSchema = Readonly<Record<string, "Str" | "Bool" | "Int">>;
type FieldValues = { Bool: boolean; Int: number; Str: string };
export type TlaFact<Schema extends TlaRecordSchema> = {
  readonly [Field in keyof Schema]: FieldValues[Schema[Field]];
};

export const moveFields = {
  eventId: "Str",
  sourceState: "Str",
  targetState: "Str",
} as const;

export const attemptFields = {
  ...moveFields,
  accepted: "Bool",
  sampleTag: "Str",
} as const;

export type ModelDataSource = () => Promise<string>;

/** A data source that builds one fixed data module. Every model generator
 *  uses it, so no generator re-declares the curried factory. */
export const modelDataFor =
  (moduleFor: () => string): ModelDataSource =>
  async () =>
    moduleFor();

/** A data source over rows with each one changed by `corrupt`. A negative
 *  control feeds it to the checker, and the checker must reject it. */
export const corruptedDataFor =
  <Row>(rows: readonly Row[], moduleFor: (rows: readonly Row[]) => string) =>
  (corrupt: (row: Row) => Row): ModelDataSource =>
    modelDataFor(() => moduleFor(rows.map(corrupt)));

/** Change the one fact the predicate names, or throw when no fact does. A
 *  negative control corrupts one fact of the clean proof data; a changed
 *  shape fails here instead of corrupting nothing. */
export const corruptOneFact = <Fact>(
  facts: readonly Fact[],
  isVictim: (fact: Fact) => boolean,
  missingMessage: string,
  corrupt: (fact: Fact) => Fact,
): readonly Fact[] => {
  if (!facts.some((fact) => isVictim(fact))) {
    throw new Error(missingMessage);
  }
  return facts.map((fact) => (isVictim(fact) ? corrupt(fact) : fact));
};

const atom = (value: TlaAtom): string =>
  typeof value === "boolean"
    ? value
      ? "TRUE"
      : "FALSE"
    : typeof value === "number"
      ? String(value)
      : JSON.stringify(value);

export const tlaSet = (values: readonly string[]): string =>
  `{${values.map(atom).join(", ")}}`;

const record = (value: TlaRecord): string =>
  `[${Object.entries(value)
    .map(([field, value]) => `${field} |-> ${atom(value)}`)
    .join(", ")}]`;

/** One field declaration supplies both the fact type and the checker type. */
export const tlaRecords = <const Schema extends TlaRecordSchema>(
  name: string,
  schema: Schema,
  values: readonly TlaFact<Schema>[],
): string => {
  const fields = Object.entries(schema)
    .map(([field, type]) => `${field}: ${type}`)
    .join(", ");
  const alias = `${name.charAt(0).toLowerCase()}${name.slice(1)}Fact`;
  return `\\* @typeAlias: ${alias} = { ${fields} };\n\\* @type: Set($${alias});\n${name} == {\n${unique(values.map(record)).join(",\n")}\n}`;
};

export const tlaModule = (
  name: string,
  definitions: readonly string[],
): string => `---- MODULE ${name} ----\n${definitions.join("\n")}\n====\n`;

/** The checker type note for one valibot field type. A field type outside the
 *  table has no checker note, so the generator stops instead of writing a
 *  wrong note. */
const TLA_TYPE_OF: Record<string, "Int" | "Bool" | "Str"> = {
  boolean: "Bool",
  number: "Int",
  picklist: "Str",
  string: "Str",
};

/** The checker type note for one valibot object schema: each field becomes a
 *  TLA primitive type, so one declaration drives both the TS record and the
 *  checker set. */
export const tlaSchemaOf = <T extends v.ObjectEntries>(
  schema: v.ObjectSchema<T, undefined>,
): Record<string, "Int" | "Bool" | "Str"> => {
  const entries = Object.entries(schema.entries) as [
    string,
    { type: string },
  ][];
  return Object.fromEntries(
    entries.map(([name, field]) => {
      const tlaType = TLA_TYPE_OF[field.type];
      if (tlaType === undefined) {
        throw new Error(`No checker type note for field type ${field.type}.`);
      }
      return [name, tlaType];
    }),
  );
};
