import * as v from "valibot";
import { requiredMapValue } from "#fp";
import {
  type ModalEdge,
  type ModalFacts,
  type ModalInput,
  type ModalNode,
  type ModalSnapshot,
  modalLifecycleFacts,
} from "#scripts/verify-models/modal-lifecycle.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  type ModalEvent,
  type ModalState,
  transitionModals,
} from "#src/ui/client/admin/modal-state.ts";
import { records } from "#test-utils/tla-data.ts";

/** Expected fact defaults describe an empty stack, not a reducer observation. */
const EMPTY: ModalSnapshot = {
  aPoint: -1,
  aRank: 0,
  aSaved: -1,
  bPoint: -1,
  bRank: 0,
  bSaved: -1,
  cRank: 0,
};
const columns = Object.keys(EMPTY) as (keyof ModalSnapshot)[];
type NextField = `next${Capitalize<keyof ModalSnapshot>}`;
export type ModalWitness = ModalSnapshot &
  Record<NextField, number> &
  ModalInput;

export const snapshotFixture = (
  fields: Partial<ModalSnapshot> = {},
): ModalSnapshot => ({
  ...EMPTY,
  ...fields,
});

/** Share only the fact format. Callers state the expected before and after
 * independently; this helper never computes a lifecycle transition. */
export const edgeFixture = (
  before: ModalSnapshot,
  after: ModalSnapshot,
  event: Pick<ModalInput, "kind" | "key" | "event"> &
    Partial<Pick<ModalInput, "input" | "limit">>,
): ModalWitness => ({
  ...before,
  ...(Object.fromEntries(
    columns.map((field) => [
      `next${field.charAt(0).toUpperCase()}${field.slice(1)}`,
      after[field],
    ]),
  ) as Record<NextField, number>),
  input: -1,
  limit: -1,
  ...event,
});

/** Read either side of one fact through the same field-format projection. */
export const snapshotFromEdge = (
  edge: ModalWitness,
  side: "before" | "after",
): ModalSnapshot =>
  Object.fromEntries(
    columns.map((field) => [
      field,
      side === "before"
        ? edge[field]
        : edge[
            `next${field.charAt(0).toUpperCase()}${field.slice(1)}` as NextField
          ],
    ]),
  ) as ModalSnapshot;

export const forgottenSaveEdge = edgeFixture(
  snapshotFixture({ aPoint: 2, aRank: 1 }),
  snapshotFixture({ aPoint: 2, aRank: 1, aSaved: 0 }),
  { event: 4, key: "a", kind: "minimise" },
);
export const threeWindowStack = snapshotFixture({
  aPoint: 0,
  aRank: 1,
  bPoint: 0,
  bRank: 2,
  cRank: 3,
});
export const closeFirstWindowEdge = edgeFixture(
  threeWindowStack,
  snapshotFixture({ bPoint: 0, bRank: 1, cRank: 2 }),
  { event: 3, key: "a", kind: "close" },
);
export const reversedSurvivorsEdge: ModalWitness = {
  ...closeFirstWindowEdge,
  nextBRank: 2,
  nextCRank: 1,
};

const snapshotOfNode = (node: ModalNode): ModalSnapshot =>
  Object.fromEntries(
    columns.map((field) => [field, node[field]]),
  ) as ModalSnapshot;

/** Hydration is test-only. The model receives compact tables, not these rows. */
export const witnessFacts = (facts: ModalFacts) => {
  const nodes = new Map(facts.snapshots.map((row) => [row.id, row]));
  const events = new Map(facts.events.map((row) => [row.event, row]));
  return {
    edges: facts.edges.map((edge) =>
      edgeFixture(
        snapshotOfNode(
          requiredMapValue(nodes, edge.source, "Missing source node"),
        ),
        snapshotOfNode(
          requiredMapValue(nodes, edge.target, "Missing target node"),
        ),
        requiredMapValue(events, edge.event, "Missing event metadata"),
      ),
    ),
    events: facts.events,
    snapshots: facts.snapshots.map(snapshotOfNode),
  };
};

const integer = v.pipe(v.number(), v.safeInteger());
const nodeSchema = v.strictObject({
  ...(Object.fromEntries(columns.map((field) => [field, integer])) as Record<
    keyof ModalSnapshot,
    typeof integer
  >),
  id: integer,
});
const eventSchema = v.strictObject({
  event: integer,
  input: integer,
  key: v.string(),
  kind: v.string(),
  limit: integer,
});

/** Parse the actual checker boundary. Runtime validation narrows record atoms
 * to integers/strings and checks every matrix cell and row width. */
export const parsedModalFacts = (data: string): ModalFacts => {
  const snapshots = v.parse(
    v.pipe(v.array(nodeSchema), v.minLength(1)),
    records(data, "Snapshots", "Seq"),
  );
  const events = v.parse(
    v.pipe(v.array(eventSchema), v.minLength(1)),
    records(data, "Events"),
  );
  const literal = requireValue(
    data.match(/Targets == ([\s\S]*?)\n====/)?.[1],
    "Missing checker Targets matrix",
  );
  const destination = v.pipe(
    integer,
    v.minValue(0),
    v.maxValue(snapshots.length - 1),
  );
  const row = v.pipe(v.array(destination), v.length(events.length));
  const targets = v.parse(
    v.pipe(v.array(row), v.length(snapshots.length)),
    JSON.parse(literal.replaceAll("<<", "[").replaceAll(">>", "]")),
  );
  const edges = targets.flatMap((destinations, source) =>
    destinations.map((target, event) => ({ event, source, target })),
  );
  return { edges, events, snapshots };
};

/** Expected links use named fixture fields, never assumed BFS id numbers. */
export const snapshotId = (
  facts: ModalFacts,
  expected: ModalSnapshot,
): number =>
  requireValue(
    facts.snapshots.find((row) =>
      columns.every((field) => row[field] === expected[field]),
    ),
    "Missing expected snapshot",
  ).id;

export const edgeIdsFor = (
  facts: ModalFacts,
  expected: ModalWitness,
): ModalEdge => ({
  event: expected.event,
  source: snapshotId(facts, snapshotFromEdge(expected, "before")),
  target: snapshotId(facts, snapshotFromEdge(expected, "after")),
});

/** A fault changes a real reducer result before the producer extracts it. */
export const modalFactsWithFault = (
  fault: (
    result: readonly ModalState[],
    before: readonly ModalState[],
    event: ModalEvent,
  ) => readonly ModalState[],
) =>
  witnessFacts(
    modalLifecycleFacts((before, event) =>
      fault(transitionModals(before, event), before, event),
    ),
  );

export const expandedWindow = (
  key: string,
  left = 0,
  top = left,
): ModalState => ({ expandedPoint: null, key, point: { left, top } });
