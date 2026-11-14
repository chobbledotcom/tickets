/** Shared fact tables and negative controls for the subscription producers. */
import {
  corruptOneFact,
  type ModelDataSource,
  type TlaFact,
  type TlaRecord,
  type TlaRecordSchema,
  tlaRecords,
} from "#scripts/verify-models/data.ts";
import type { CheckPhase, ModelControl } from "#scripts/verify-models/spec.ts";
import { requireValue } from "#shared/required-value.ts";

/** Each fact table has its checker name and its field types. */
type FactTables = Readonly<
  Record<string, readonly [name: string, fields: TlaRecordSchema]>
>;

/** The rows that a producer collects, under the same keys as the tables. */
export type FactsOf<Tables extends FactTables> = {
  -readonly [Table in keyof Tables]: TlaFact<Tables[Table][1]>[];
};

/** Renders each fact table as one checker record set, in declaration order. */
export const recordSetsFor =
  <Tables extends FactTables>(tables: Tables) =>
  (facts: FactsOf<Tables>): string[] => {
    const rows: Readonly<Record<string, readonly TlaRecord[]>> = facts;
    return Object.entries(tables).map(([table, [name, fields]]) =>
      tlaRecords(
        name,
        fields,
        requireValue(rows[table], `The fact table ${table} has no rows.`),
      ),
    );
  };

/** The field values, as text, that select the facts a control changes. */
type Victim = Readonly<Record<string, string>>;

/** A step control: its name, fact table, corrupted field, the wrong text for
 * a text field, and its victim. */
type FieldFault = readonly [
  name: string,
  table: string,
  field: string,
  wrongText: string,
  victim: Victim,
];

/** A control that removes facts: its name, phase, fact table, and victim. */
type MissingFault = readonly [
  name: string,
  phase: CheckPhase,
  table: string,
  victim: Victim,
];

const isVictimOf =
  (victim: Victim) =>
  (fact: TlaRecord): boolean =>
    Object.entries(victim).every(
      ([field, value]) => String(fact[field]) === value,
    );

/** A wrong value of the same type: the other flag, the next number, or the
 * wrong text. */
const wrongValue = (
  value: TlaRecord[string],
  wrongText: string,
): TlaRecord[string] => {
  if (typeof value === "boolean") return !value;
  return typeof value === "number" ? value + 1 : wrongText;
};

const withWrongField =
  ([name, , field, wrongText]: FieldFault) =>
  (fact: TlaRecord): TlaRecord => ({
    ...fact,
    [field]: wrongValue(
      requireValue(fact[field], `The ${name} control names no field.`),
      wrongText,
    ),
  });

/** The fault tables of one producer. */
export type Faults = {
  readonly fields: readonly FieldFault[];
  readonly missing: readonly MissingFault[];
};

/** Fresh facts with one change, as the data of a control. */
type ChangedData<Facts> = (change: (facts: Facts) => void) => ModelDataSource;

/** Binds one producer's fresh facts to its clean data and its controls. Each
 * control collects new facts, so no control reads cached clean output.
 * `tablesOf` gives the fact tables that the fault tables can name. `others`
 * adds the controls that no fault table can express. */
export const producerFor = <Facts>(
  load: () => Promise<Facts>,
  render: (facts: Facts) => string,
  tablesOf: (facts: Facts) => Readonly<Record<string, TlaRecord[]>>,
  faults: Faults,
  others: (changedData: ChangedData<Facts>) => readonly ModelControl[],
): { controls: readonly ModelControl[]; modelData: ModelDataSource } => {
  const changedData: ChangedData<Facts> = (change) => async () => {
    const facts = await load();
    const before = render(facts);
    change(facts);
    const after = render(facts);
    if (before === after) throw new Error("The control changed no model fact.");
    return after;
  };
  const tableControl = (
    name: string,
    phase: CheckPhase,
    table: string,
    change: (rows: TlaRecord[]) => void,
  ): ModelControl => ({
    data: changedData((facts) =>
      change(
        requireValue(
          tablesOf(facts)[table],
          `The ${name} control names no fact table.`,
        ),
      ),
    ),
    name,
    phase,
  });
  const fieldControl = (fault: FieldFault): ModelControl => {
    const [name, table, , , victim] = fault;
    return tableControl(name, "step", table, (rows) => {
      const changed = corruptOneFact(
        rows,
        isVictimOf(victim),
        `The ${name} control has no target.`,
        withWrongField(fault),
      );
      Object.assign(rows, changed);
    });
  };
  const missingControl = ([
    name,
    phase,
    table,
    victim,
  ]: MissingFault): ModelControl =>
    tableControl(name, phase, table, (rows) => {
      const isVictim = isVictimOf(victim);
      rows.splice(0, rows.length, ...rows.filter((fact) => !isVictim(fact)));
    });
  return {
    controls: [
      ...faults.fields.map(fieldControl),
      ...faults.missing.map(missingControl),
      ...others(changedData),
    ],
    modelData: async () => render(await load()),
  };
};
