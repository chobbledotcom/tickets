/** The declared contracts this repository pins in code, as one plain JSON
 * shape: every state machine's states, moves, and money flags, plus the
 * joint-state seam. `deno task contract:diff` dumps this shape from the
 * head and from a base worktree, then reports the semantic changes.
 *
 * This module also runs inside the base worktree, which holds an older
 * tree. The machine events load lazily, one per machine the LOCAL atlas
 * lists: a machine that only the head has never loads here, so a branch
 * that adds a machine still gets its base dump. It imports only `#shared`
 * declarations and nothing from `#scripts`. */

import * as v from "valibot";
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

/** One machine's contract: its states, its start, the moves its real
 * transitions prove, and the events that send money. */
export const DumpedMachineSchema = v.object({
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

/** One machine's events, loaded only when this tree's atlas lists that
 * machine. */
type EventsLoader = () => Promise<MachineEvents>;

const EVENT_LOADERS: Readonly<Record<string, EventsLoader>> = {
  refund: () =>
    import("#payment/refund-machine-spec.ts").then((m) => m.REFUND_EVENTS),
  review: () =>
    import("#payment/review-machine-spec.ts").then((m) => m.REVIEW_EVENTS),
  row: () => import("#payment/row-machine-spec.ts").then((m) => m.ROW_EVENTS),
  square_link_ends: () =>
    import("#payment/square-link-end-machine-spec.ts").then(
      (m) => m.LINK_END_EVENTS,
    ),
  sumup_recovery: () =>
    import("#payment/sumup-recovery-machine-spec.ts").then(
      (m) => m.RECOVERY_EVENTS,
    ),
};

/** Sorted copy, so one dump of one tree is always the same JSON. */
export const sortedStrings = (values: readonly string[]): string[] =>
  [...values].sort();

/** The event id behind one edge label. An edge without an event is a
 * declaration gap, so the dump stops rather than guess. */
const eventIdFor = (events: MachineEvents, labelKey: string): string => {
  const event = events.find((candidate) => candidate.labelKey === labelKey);
  if (event === undefined) {
    throw new Error(`No machine event carries the label key ${labelKey}`);
  }
  return event.id;
};

/** One machine's contract, folded from its atlas entry and its events. */
export const dumpMachine = (
  machine: AtlasMachine,
  events: MachineEvents,
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
    start: start.id,
    states: sortedStrings(machine.states.map((state) => state.id)),
  };
};

/** The events of one machine this tree's atlas lists. A machine without a
 * loader stops the dump: its money flags and edge names are unknown. */
const loadEvents = (machineId: string): Promise<MachineEvents> => {
  const loader = EVENT_LOADERS[machineId];
  if (loader === undefined) {
    throw new Error(
      `Machine ${machineId} joined the atlas; the drift dump must learn its events`,
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
    dumped[machine.id] = dumpMachine(machine, await loadEvents(machine.id));
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
