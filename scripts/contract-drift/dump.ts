/** The declared contracts this repository pins in code, as one plain JSON
 * shape: every state machine's states, moves, and money flags, plus the
 * joint-state seam. `deno task contract:diff` dumps this shape from the
 * head and from a base worktree, then reports the semantic changes.
 *
 * This module also runs inside the base worktree, which holds an older
 * tree. Each machine's events and declared table load lazily, per machine
 * the LOCAL atlas lists: a machine that only the head has never loads
 * here, so a branch that adds a machine still gets its base dump. A table
 * module the tree does not have reads back as no table, which the differ
 * reports as an added table. Every module this file imports must also
 * exist in that older tree, so it imports no helper that a branch adds.
 * It imports nothing from `#scripts`. */

import * as v from "valibot";
import { sort } from "#fp";
import { ILLEGAL_JOINT_STATES } from "#payment/joint-state.ts";
import { SCHEMA_ATLAS_MACHINES } from "#shared/schema-atlas/index.ts";
import type { AtlasMachine } from "#shared/schema-atlas/types.ts";

/** One way a stored record can move, as the drift report names it. */
export const DumpedEdgeSchema = v.object({
  actor: v.string(),
  event: v.string(),
  to: v.string(),
});
export type DumpedEdge = v.InferOutput<typeof DumpedEdgeSchema>;

/** One declared cell: the node one event must land on, or a node per
 * stored shape when capability rules split the outcome. */
export const DumpedMoveCellSchema = v.union([
  v.string(),
  v.object({ perRep: v.record(v.string(), v.string()) }),
]);
export type DumpedMoveCell = v.InferOutput<typeof DumpedMoveCellSchema>;

/** One machine's declared table: for each node, the events that must move
 * it and where to. A cell the table leaves out is a declared refusal. */
export const DumpedDeclaredMovesSchema = v.record(
  v.string(),
  v.record(v.string(), DumpedMoveCellSchema),
);
export type DumpedDeclaredMoves = v.InferOutput<
  typeof DumpedDeclaredMovesSchema
>;

/** One machine's contract: its states, its start, the moves its real
 * transitions prove, the table that declares them, and the events that
 * send money. */
export const DumpedMachineSchema = v.object({
  declaredMoves: v.optional(DumpedDeclaredMovesSchema),
  edges: v.record(v.string(), v.array(DumpedEdgeSchema)),
  moneyEvents: v.array(v.string()),
  start: v.string(),
  states: v.array(v.string()),
});
export type DumpedMachine = v.InferOutput<typeof DumpedMachineSchema>;

/** One entry of the declared seam: a joint state the flows say cannot
 * exist. */
export const DumpedJointStateSchema = v.object({
  authority: v.string(),
  rows: v.array(v.string()),
});
export type DumpedJointState = v.InferOutput<typeof DumpedJointStateSchema>;

/** Every declared contract in one shape, so two checkouts can diff. */
export const ContractsSchema = v.object({
  jointStates: v.array(DumpedJointStateSchema),
  machines: v.record(v.string(), DumpedMachineSchema),
});
export type Contracts = v.InferOutput<typeof ContractsSchema>;

/** How one joint-state entry reads in a report. */
export const jointStateKey = (state: DumpedJointState): string =>
  `${state.authority} cannot sit on ${state.rows.join(", ")}`;

/** The events whose label keys name a machine's edges, by machine id. */
type MachineEvents = readonly {
  readonly id: string;
  readonly labelKey: string;
  readonly movesMoney: boolean;
}[];

/** One machine's declared table, validated into the dump's shape, or
 * undefined when the module that holds it does not exist in this tree: a
 * branch can introduce a table the base never had, and the base dump then
 * reports no table, which the differ reports as an added table. Any other
 * failure stops the dump. */
export const declaredTableOrNone = async (
  machineId: string,
  load: () => unknown,
): Promise<DumpedDeclaredMoves | undefined> => {
  let table: unknown;
  try {
    table = await load();
  } catch (error) {
    if (error instanceof TypeError && /module not found/i.test(error.message)) {
      return;
    }
    throw error;
  }
  const parsed = v.safeParse(DumpedDeclaredMovesSchema, table);
  if (!parsed.success) {
    throw new Error(
      `Machine ${machineId}'s declared table is not the dumped shape`,
    );
  }
  return parsed.output;
};

/** One machine's declared contract pieces: its events beside its declared
 * table. */
type MachineContract = {
  declaredMoves: DumpedDeclaredMoves | undefined;
  events: MachineEvents;
};

type MachineLoader = () => Promise<MachineContract>;

/** One machine's declared contract: its events beside its declared table,
 * the table read through the dump's own validator. */
const machineContract = async (
  machineId: string,
  events: MachineEvents,
  table: () => unknown,
): Promise<MachineContract> => ({
  declaredMoves: await declaredTableOrNone(machineId, table),
  events,
});

const MACHINE_LOADERS: Readonly<Record<string, MachineLoader>> = {
  refund: () =>
    import("#payment/refund-machine-spec.ts").then((m) =>
      machineContract("refund", m.REFUND_EVENTS, () => m.EXPECTED_MOVES),
    ),
  review: () =>
    import("#payment/review-machine-spec.ts").then((m) =>
      machineContract("review", m.REVIEW_EVENTS, () =>
        import(
          "#test/shared/payment/review-machine-spec/expected-moves.ts"
        ).then((t) => t.EXPECTED_MOVES),
      ),
    ),
  row: () =>
    import("#payment/row-machine-spec.ts").then((m) =>
      machineContract("row", m.ROW_EVENTS, () =>
        import("#test/shared/payment/row-machine-spec/expected-moves.ts").then(
          (t) => t.EXPECTED_MOVES,
        ),
      ),
    ),
  square_link_ends: () =>
    import("#payment/square-link-end-machine-spec.ts").then((m) =>
      machineContract(
        "square_link_ends",
        m.LINK_END_EVENTS,
        () => m.LINK_END_MOVES,
      ),
    ),
  sumup_recovery: () =>
    import("#payment/sumup-recovery-machine-spec.ts").then((m) =>
      machineContract(
        "sumup_recovery",
        m.RECOVERY_EVENTS,
        () => m.RECOVERY_MOVES,
      ),
    ),
};

/** Sorted copy, so one dump of one tree is always the same JSON. */
export const sortedStrings = (values: readonly string[]): string[] =>
  [...values].sort();

/** The entries of one record in the key order sortedStrings gives, so one
 * tree always dumps the same JSON. It sorts with the `#fp` `sort` because
 * the base worktree runs this file against an older tree. */
const sortedEntries = <Value>(entries: [string, Value][]): [string, Value][] =>
  sort(([left]: [string, Value], [right]: [string, Value]) =>
    left < right ? -1 : 1,
  )(entries);

/** The event id behind one edge label. An edge without an event is a
 * declaration gap, so the dump stops rather than guess. */
const eventIdFor = (events: MachineEvents, labelKey: string): string => {
  const event = events.find((candidate) => candidate.labelKey === labelKey);
  if (event === undefined) {
    throw new Error(`No machine event carries the label key ${labelKey}`);
  }
  return event.id;
};

/** One machine's contract, folded from its atlas entry, its events, and
 * its declared table. */
export const dumpMachine = (
  machine: AtlasMachine,
  events: MachineEvents,
  declaredMoves?: DumpedDeclaredMoves | undefined,
): DumpedMachine => {
  const startStates = machine.states.filter((state) => state.start === true);
  const start = startStates[0];
  if (start === undefined || startStates.length !== 1) {
    throw new Error(`Machine ${machine.id} must declare exactly one start`);
  }
  const edges: Record<string, DumpedEdge[]> = {};
  for (const state of machine.states) {
    edges[state.id] = state.edges.map((edge) => ({
      actor: edge.actor,
      event: eventIdFor(events, edge.labelKey),
      to: edge.to,
    }));
  }
  const dumped: DumpedMachine = {
    edges,
    moneyEvents: sortedStrings(
      events.filter((event) => event.movesMoney).map((event) => event.id),
    ),
    start: start.id,
    states: sortedStrings(machine.states.map((state) => state.id)),
  };
  if (declaredMoves !== undefined) {
    dumped.declaredMoves = sortedDeclaredMoves(declaredMoves);
  }
  return dumped;
};

/** The declared table with its nodes, events, and split shapes in sorted
 * key order, so one tree always dumps the same JSON. */
const sortedDeclaredMoves = (
  table: DumpedDeclaredMoves,
): DumpedDeclaredMoves => {
  const moves: DumpedDeclaredMoves = {};
  for (const [node, cells] of sortedEntries(Object.entries(table))) {
    const sorted: Record<string, DumpedMoveCell> = {};
    for (const [event, cell] of sortedEntries(Object.entries(cells))) {
      sorted[event] =
        typeof cell === "string"
          ? cell
          : {
              perRep: Object.fromEntries(
                sortedEntries(Object.entries(cell.perRep)),
              ),
            };
    }
    moves[node] = sorted;
  }
  return moves;
};

/** The events and declared table of one machine this tree's atlas lists.
 * A machine without a loader stops the dump: its contract is unknown. */
const loadMachine = (machineId: string): Promise<MachineContract> => {
  const loader = MACHINE_LOADERS[machineId];
  if (loader === undefined) {
    throw new Error(
      `Machine ${machineId} joined the atlas; the drift dump must learn its events and declared moves`,
    );
  }
  return loader();
};

/** Fold atlas machines into contracts. */
export const contractsFromAtlas = async (
  machines: readonly AtlasMachine[],
): Promise<Contracts> => {
  const dumped: Record<string, DumpedMachine> = {};
  for (const machine of machines) {
    const { declaredMoves, events } = await loadMachine(machine.id);
    dumped[machine.id] = dumpMachine(machine, events, declaredMoves);
  }
  return {
    jointStates: ILLEGAL_JOINT_STATES.map((entry) => ({
      authority: entry.authority,
      rows: sortedStrings(entry.rows),
    })).sort((left, right) =>
      jointStateKey(left).localeCompare(jointStateKey(right)),
    ),
    machines: dumped,
  };
};

/** This checkout's declared contracts. */
export const currentContracts = (): Promise<Contracts> =>
  contractsFromAtlas(SCHEMA_ATLAS_MACHINES);
