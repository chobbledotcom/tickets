import {
  type TlaFact,
  type TlaRecordSchema,
  tlaModule,
  tlaRecords,
} from "#scripts/verify-models/data.ts";
import { requireValue } from "#shared/required-value.ts";

/** The facts that the matrix reads: dense ids, and one edge for each source
 * and event. A model may carry more fields on its rows. */
export type TargetFacts = {
  readonly snapshots: readonly { readonly id: number }[];
  readonly events: readonly { readonly event: number }[];
  readonly edges: readonly {
    readonly event: number;
    readonly source: number;
    readonly target: number;
  }[];
};

const boundedIndex = (value: number, count: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= count) {
    throw new Error(`Invalid modal ${field} index: ${value}`);
  }
  return value;
};

const orderedIds = <Row>(
  rows: readonly Row[],
  id: (row: Row) => number,
  kind: "state" | "event",
): void => {
  for (const [index, row] of rows.entries()) {
    if (id(row) !== index)
      throw new Error(`Modal ${kind} ids are not dense and ordered`);
  }
};

/** Every selected source/event pair has exactly one observed destination.
 * Reject missing, duplicate, noninteger, and out-of-domain links before render. */
export const modalTargets = (
  facts: TargetFacts,
): readonly (readonly number[])[] => {
  if (facts.snapshots.length === 0 || facts.events.length === 0) {
    throw new Error("Empty modal transition domain");
  }
  orderedIds(facts.snapshots, (row) => row.id, "state");
  orderedIds(facts.events, (row) => row.event, "event");
  const rows = Array.from({ length: facts.snapshots.length }, () =>
    Array<number | undefined>(facts.events.length),
  );
  for (const edge of facts.edges) {
    const source = boundedIndex(edge.source, rows.length, "source");
    const event = boundedIndex(edge.event, facts.events.length, "event");
    const target = boundedIndex(edge.target, rows.length, "target");
    const row = rows[source]!;
    if (row[event] !== undefined) throw new Error("Duplicate modal transition");
    row[event] = target;
  }
  return rows.map((row, source) =>
    Array.from(row, (target, event) =>
      requireValue(target, `Missing modal transition ${source}/${event}`),
    ),
  );
};

/** The checker data of a model: the screen rows, the event rows, and the
 * matrix with one target for each source and event. */
export const matrixModule = <
  const Node extends TlaRecordSchema,
  const Input extends TlaRecordSchema,
>(
  name: string,
  schemas: { readonly events: Input; readonly snapshots: Node },
  facts: TargetFacts & {
    readonly events: readonly TlaFact<Input>[];
    readonly snapshots: readonly TlaFact<Node>[];
  },
): string =>
  tlaModule(name, [
    tlaRecords("Snapshots", schemas.snapshots, facts.snapshots, "Seq"),
    tlaRecords("Events", schemas.events, facts.events),
    `\\* @type: Seq(Seq(Int));\nTargets == <<\n${modalTargets(facts)
      .map((row) => `<<${row.join(", ")}>>`)
      .join(",\n")}\n>>`,
  ]);
