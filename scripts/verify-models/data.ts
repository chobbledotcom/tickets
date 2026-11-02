import type * as v from "valibot";
import { unique } from "#fp";
import type { ModelLanguage } from "#scripts/verify-models/spec.ts";

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

const atom = (
  value: TlaAtom,
  field: string,
  language: ModelLanguage,
): string => {
  if (typeof value === "boolean") {
    if (language === "tla") return value ? "TRUE" : "FALSE";
    return String(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`The model integer at ${field} is not a safe integer.`);
    }
    return String(value);
  }
  return JSON.stringify(value);
};

const setOf = (values: readonly string[], language: ModelLanguage): string => {
  const members = values
    .map((value) => atom(value, "set member", language))
    .join(", ");
  return language === "tla" ? `{${members}}` : `Set(${members})`;
};

const setWriter =
  (language: ModelLanguage) =>
  (values: readonly string[]): string =>
    setOf(values, language);

export const tlaSet = setWriter("tla");

export const quintSet = setWriter("quint");

const recordOf = (
  value: TlaRecord,
  name: string,
  language: ModelLanguage,
): string => {
  const fields = Object.entries(value)
    .map(([field, value]) => {
      const text = atom(value, `${name}.${field}`, language);
      return language === "tla" ? `${field} |-> ${text}` : `${field}: ${text}`;
    })
    .join(", ");
  return language === "tla" ? `[${fields}]` : `{ ${fields} }`;
};

const fieldText = <const Schema extends TlaRecordSchema>(
  schema: Schema,
  typeOf: (type: Schema[keyof Schema]) => string,
): string =>
  Object.entries(schema)
    .map(([field, type]) => `${field}: ${typeOf(type as Schema[keyof Schema])}`)
    .join(", ");

const rowText = <const Schema extends TlaRecordSchema>(
  name: string,
  values: readonly TlaFact<Schema>[],
  language: ModelLanguage,
  indent = "",
): string =>
  unique(
    values.map(
      (value, index) =>
        `${indent}${recordOf(value, `${name}[${index}]`, language)}`,
    ),
  ).join(",\n");

/** The Quint primitive type of each checker type note. */
const QUINT_TYPE_OF: Record<"Bool" | "Int" | "Str", string> = {
  Bool: "bool",
  Int: "int",
  Str: "str",
};

/** One field declaration supplies both the fact type and the checker type.
 *  `typeName` names the Quint record type, because a Quint type and a value
 *  cannot share one name. */
export const modelRecords = <const Schema extends TlaRecordSchema>(
  name: string,
  schema: Schema,
  values: readonly TlaFact<Schema>[],
  language: ModelLanguage,
  typeName = name,
): string => {
  const fields = fieldText(schema, (type) =>
    language === "tla" ? type : QUINT_TYPE_OF[type],
  );
  const rows = rowText(name, values, language, language === "tla" ? "" : "  ");
  if (language === "tla") {
    const alias = `${name.charAt(0).toLowerCase()}${name.slice(1)}Fact`;
    return `\\* @typeAlias: ${alias} = { ${fields} };\n\\* @type: Set($${alias});\n${name} == {\n${rows}\n}`;
  }
  return `type ${typeName} = { ${fields} }\n\npure val ${name}: Set[${typeName}] = Set(\n${rows}\n)`;
};

const moduleWriter =
  (open: (name: string) => string, close: string, separator: string) =>
  (name: string, definitions: readonly string[]): string =>
    `${open(name)}\n${definitions.join(separator)}\n${close}\n`;

export const tlaModule = moduleWriter(
  (name) => `---- MODULE ${name} ----\nEXTENDS Integers`,
  "====",
  "\n",
);

export const quintModule = moduleWriter(
  (name) => `module ${name} {`,
  "}",
  "\n\n",
);

/** Binds one module's name and the name and field schema of every record
 *  table in it. Each call supplies the rows and returns the module text. */
export const tlaRecordModuleFor =
  <const Schemas extends readonly TlaRecordSchema[]>(
    name: string,
    ...tables: {
      readonly [Index in keyof Schemas]: readonly [
        name: string,
        schema: Schemas[Index],
      ];
    }
  ) =>
  (
    ...rows: {
      readonly [Index in keyof Schemas]: readonly TlaFact<Schemas[Index]>[];
    }
  ): string =>
    tlaModule(
      name,
      tables.map(([table, schema], index) =>
        modelRecords(table, schema, rows[index]!, "tla"),
      ),
    );

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
