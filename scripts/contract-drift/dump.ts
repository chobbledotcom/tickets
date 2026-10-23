/** The declared contracts this repository pins in code, as one plain JSON
 * shape: every state machine's states, moves, and money flags, its
 * declared moves table, plus the joint-state seam. `deno task
 * contract:diff` dumps this shape from the head and from a base worktree,
 * then reports the semantic changes.
 *
 * The executed moves come from the atlas: `atlasMachineFrom` runs every
 * transition against the node representatives. The declared moves tables
 * come from each machine's own `EXPECTED_MOVES`-style table, which
 * production enforces through the moves readers — a cell the table lacks
 * is a declared refusal that a change to a transition function alone
 * would not surface.
 *
 * This module also runs inside the base worktree, which holds an older
 * tree. It imports only `#shared` and `#test` declarations the base
 * already has, and nothing from `#scripts`. The machine events and the
 * moves-table helpers load lazily, one per machine the LOCAL atlas
 * lists: a machine that only the head has never loads here, so a branch
 * that adds a machine still gets its base dump. */

import * as v from "valibot";
import { ILLEGAL_JOINT_STATES } from "#payment/joint-state.ts";
import { SCHEMA_ATLAS_MACHINES } from "#shared/schema-atlas/index.ts";
import type { MachineMoves } from "#shared/schema-atlas/machine-spec.ts";
import type { AtlasMachine } from "#shared/schema-atlas/types.ts";

/** One way a stored record can move, as the drift report names it. */
export const DumpedEdgeSchema = v.object({
  actor: v.string(),
  event: v.string(),
  to: v.string(),
});
export type DumpedEdge = v.InferOutput<typeof DumpedEdgeSchema>;

/** One declared cell: the single landing node, or a per-shape split. */
export const DumpedCellSchema = v.union([
  v.object({ target: v.string() }),
  v.object({ perRep: v.record(v.string(), v.string()) }),
]);
export type DumpedCell = v.InferOutput<typeof DumpedCellSchema>;

/** The declared moves table of one machine: for each node, the events
 * that must move it and where. A cell the table lacks is a declared
 * refusal. */
export const DumpedMovesSchema = v.record(
  v.string(),
  v.record(v.string(), DumpedCellSchema),
);
export type DumpedMoves = v.InferOutput<typeof DumpedMovesSchema>;

/** One machine's contract: its states, its start, the moves its real
 * transitions prove, its declared moves table (null when this tree
 * predates its helper), and the events that send money. */
export const DumpedMachineSchema = v.object({
  edges: v.record(v.string(), v.array(DumpedEdgeSchema)),
  moneyEvents: v.array(v.string()),
  moves: v.nullable(DumpedMovesSchema),
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

/** One machine's events, loaded only when this tree's atlas lists that
 * machine. */
type EventsLoader = () => Promise<MachineEvents>;

/** One machine's declared moves table, folded to the dump's own shape.
 * Each machine's `EXPECTED_MOVES`-style table is `MachineMoves<NodeId,
 * EventId>`: its cells are typed optional because an absent cell is a
 * declared refusal. An entry `Object.entries` visits is present, so the
 * fold reads it without the optional-celled noise. */
type MovesLoader = () => Promise<DumpedMoves>;

/** One machine's events and declared moves, loaded only when this tree's
 * atlas lists the machine. */
type MachineLoaders = {
  readonly events: EventsLoader;
  readonly moves: MovesLoader;
};

/** The events of one machine module, named by its events export. */
const eventsFromModule =
  (specifier: string, exportName: string): EventsLoader =>
  () =>
    import(specifier).then((m) => m[exportName]);

/** The declared moves of one machine module, by its moves export name. */
const movesFromModule =
  (specifier: string, exportName: string): MovesLoader =>
  () =>
    import(specifier).then((m) => dumpMoves(m[exportName]));

const MACHINE_LOADERS: Readonly<Record<string, MachineLoaders>> = {
  refund: {
    events: eventsFromModule(
      "#payment/refund-machine-spec.ts",
      "REFUND_EVENTS",
    ),
    moves: movesFromModule("#payment/refund-machine-spec.ts", "EXPECTED_MOVES"),
  },
  review: {
    events: eventsFromModule(
      "#payment/review-machine-spec.ts",
      "REVIEW_EVENTS",
    ),
    moves: movesFromModule(
      "#test/shared/payment/review-machine-spec/expected-moves.ts",
      "EXPECTED_MOVES",
    ),
  },
  row: {
    events: eventsFromModule("#payment/row-machine-spec.ts", "ROW_EVENTS"),
    moves: movesFromModule(
      "#test/shared/payment/row-machine-spec/expected-moves.ts",
      "EXPECTED_MOVES",
    ),
  },
  square_link_ends: {
    events: eventsFromModule(
      "#payment/square-link-end-machine-spec.ts",
      "LINK_END_EVENTS",
    ),
    moves: movesFromModule(
      "#payment/square-link-end-machine-spec.ts",
      "LINK_END_MOVES",
    ),
  },
  sumup_recovery: {
    events: eventsFromModule(
      "#payment/sumup-recovery-machine-spec.ts",
      "RECOVERY_EVENTS",
    ),
    moves: movesFromModule(
      "#payment/sumup-recovery-machine-spec.ts",
      "RECOVERY_MOVES",
    ),
  },
};

/** Sorted copy, so one dump of one tree is always the same JSON. */
export const sortedStrings = (values: readonly string[]): string[] =>
  [...values].sort();

/** One record's entries sorted by key, so one dump of one tree is always
 * the same JSON. */
const sortedEntries = <Value>(
  record: Readonly<Record<string, Value>>,
): [string, Value][] =>
  Object.entries(record).sort(([a], [b]) => a.localeCompare(b));

/** The event id behind one edge label. An edge without an event is a
 * declaration gap, so the dump stops rather than guess. */
const eventIdFor = (events: MachineEvents, labelKey: string): string => {
  const event = events.find((candidate) => candidate.labelKey === labelKey);
  if (event === undefined) {
    throw new Error(`No machine event carries the label key ${labelKey}`);
  }
  return event.id;
};

/** One machine's declared moves table as a total object. The machine
 * types mark every cell optional because an absent cell is a declared
 * refusal; `Object.entries` visits only cells that exist, so the fold
 * narrows to the total shape once, at this boundary. */
type TotalMoves = Readonly<
  Record<
    string,
    Readonly<
      Record<string, string | { perRep: Readonly<Record<string, string>> }>
    >
  >
>;

/** The split's branches, each tag landing on a real node. */
const perRepOf = (split: {
  perRep: Readonly<Record<string, string>>;
}): Record<string, string> => {
  const perRep: Record<string, string> = {};
  for (const [tag, target] of Object.entries(split.perRep)) {
    perRep[tag] = target;
  }
  return perRep;
};

/** One machine's declared table as the dump holds it, with every key
 * sorted so one dump of one tree is always the same JSON. */
const dumpMoves = <NodeId extends string, EventId extends string>(
  table: MachineMoves<NodeId, EventId>,
): DumpedMoves => {
  const total = table as unknown as TotalMoves;
  const dumped: Record<string, Record<string, DumpedCell>> = {};
  for (const [from, cells] of sortedEntries(total)) {
    const row: Record<string, DumpedCell> = {};
    for (const [event, move] of sortedEntries(cells)) {
      row[event] =
        typeof move === "string"
          ? { target: move }
          : { perRep: perRepOf(move) };
    }
    dumped[from] = row;
  }
  return dumped;
};

/** One machine's contract, folded from its atlas entry, its events, and
 * its declared moves table. */
export const dumpMachine = (
  machine: AtlasMachine,
  events: MachineEvents,
  moves: DumpedMoves | null,
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
  return {
    edges,
    moneyEvents: sortedStrings(
      events.filter((event) => event.movesMoney).map((event) => event.id),
    ),
    moves,
    start: start.id,
    states: sortedStrings(machine.states.map((state) => state.id)),
  };
};

/** The events of one machine this tree's atlas lists. A machine without a
 * loader stops the dump: its money flags and edge names are unknown. */
const loadEvents = (machineId: string): Promise<MachineEvents> => {
  const machine = MACHINE_LOADERS[machineId];
  if (machine === undefined) {
    throw new Error(
      `Machine ${machineId} joined the atlas; the drift dump must learn its events`,
    );
  }
  return machine.events();
};

/** Run one moves loader, or null when the module is missing from this
 * tree. The machine still exists here; only its table is not yet a
 * module, so absence is a real, named outcome for an older base. Any
 * other failure stays a failure. */
export const movesOrNull = async (
  loader: () => Promise<DumpedMoves>,
): Promise<DumpedMoves | null> => {
  try {
    return await loader();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("Module not found")
    ) {
      throw error;
    }
    return null;
  }
};

/** The declared moves table of one machine this tree's atlas lists, or
 * null when the machine has no declared table loader, or when this tree
 * predates its helper module. */
export const loadMoves = async (
  machineId: string,
): Promise<DumpedMoves | null> => {
  const machine = MACHINE_LOADERS[machineId];
  if (machine === undefined) return null;
  return movesOrNull(machine.moves);
};

/** Fold atlas machines into contracts. */
export const contractsFromAtlas = async (
  machines: readonly AtlasMachine[],
): Promise<Contracts> => {
  const dumped: Record<string, DumpedMachine> = {};
  for (const machine of machines) {
    dumped[machine.id] = dumpMachine(
      machine,
      await loadEvents(machine.id),
      await loadMoves(machine.id),
    );
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
