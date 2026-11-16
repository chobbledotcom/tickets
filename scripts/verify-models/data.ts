import type * as v from "valibot";
import { unique } from "#fp";

type TlaAtom = string | boolean | number;

export type TlaRecord = Readonly<Record<string, TlaAtom>>;
export type TlaRecordSchema = Readonly<Record<string, "Str" | "Bool" | "Int">>;
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

const atom = (value: TlaAtom, field: string): string => {
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`The TLA integer at ${field} is not a safe integer.`);
    }
    return String(value);
  }
  return JSON.stringify(value);
};

export const tlaSet = (values: readonly string[]): string =>
  `{${values.map((value) => atom(value, "set member")).join(", ")}}`;

const record = (value: TlaRecord, name: string): string =>
  `[${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, value]) => `${field} |-> ${atom(value, `${name}.${field}`)}`)
    .join(", ")}]`;

// Each indexed lookup selects a page, then at most 32 rows within that page.
// This avoids a single recursive equality builder over the entire fact table
// while retaining the original semantic set.
const RECORD_PAGE_SIZE = 32;

const indexedDefinitions = (
  name: string,
  type: string,
  values: readonly string[],
): string[] => {
  const pages: string[] = [];
  for (let index = 0; index < values.length; index += RECORD_PAGE_SIZE) {
    pages.push(
      `<<${values.slice(index, index + RECORD_PAGE_SIZE).join(", ")}>>`,
    );
  }
  return [
    `\\* @type: Seq(Seq(${type}));\n${name}Pages == <<${pages.join(",\n")}>>`,
    `${name}Count == ${values.length}`,
    `${name}Indices == 1..${values.length}`,
    `\\* ${name}At requires index \\in ${name}Indices; no value is defined outside that domain.`,
    `\\* @type: (Int) => ${type};\n${name}At(index) == ${name}Pages[((index - 1) \\div ${RECORD_PAGE_SIZE}) + 1][((index - 1) % ${RECORD_PAGE_SIZE}) + 1]`,
  ];
};

/** Preserve a semantic string set and index its distinct identities separately. */
export const tlaStringSet = (name: string, values: readonly string[]): string =>
  [
    `${name} == ${tlaSet(values)}`,
    ...indexedDefinitions(
      name,
      "Str",
      unique([...values]).map((value) => atom(value, "set member")),
    ),
  ].join("\n");

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
  const rows = unique(
    values.map((value, index) => record(value, `${name}[${index}]`)),
  );
  const names = rows.map((_, index) => `${name}Record${index}`);
  const definitions = rows.map(
    (row, index) => `\\* @type: $${alias};\n${names[index]} == ${row}`,
  );
  return [
    `\\* @typeAlias: ${alias} = { ${fields} };`,
    ...definitions,
    `\\* @type: Set($${alias});\n${name} == {\n${names.join(",\n")}\n}`,
    ...indexedDefinitions(name, `$${alias}`, names),
  ].join("\n");
};

export const tlaModule = (
  name: string,
  definitions: readonly string[],
): string =>
  `---- MODULE ${name} ----\nEXTENDS Integers\n${definitions.join("\n")}\n====\n`;

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
        tlaRecords(table, schema, rows[index]!),
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
