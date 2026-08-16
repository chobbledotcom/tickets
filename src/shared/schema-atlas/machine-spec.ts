/** The shared shape of one executable machine table.
 *
 * An atlas machine DESCRIBES itself: it draws whatever the real transitions
 * do, so it can never fail. A machine spec adds the half that can: the
 * nodes' stored shapes, the events that move them, and a declared table of
 * exactly where every (node × event × shape) cell must land. Mirror tests
 * execute every cell against the real transition functions; a cell missing
 * from the table is the declaration that the transition must refuse
 * (throw), and the sweep proves that too. */

import { compact } from "#fp";
import {
  type AtlasState,
  type AtlasTrigger,
  atlasState,
  edgesFromTriggers,
} from "#shared/schema-atlas/types.ts";

/** One stored shape standing for a whole family the machine must treat the
 * same way (keyed and keyless, say). */
export type MachineRepresentative<State> = {
  readonly state: State;
  readonly tag: string;
};

export const machineRep = <State>(
  tag: string,
  state: State,
): MachineRepresentative<State> => ({ state, tag });

/** One map node: its stored shapes, and — when no owner or system event can
 * move it toward the terminal — the declared reason it is allowed to wait. */
export type MachineNode<State, NodeId extends string> = {
  readonly awaits?: "provider";
  readonly id: NodeId;
  readonly reps: readonly MachineRepresentative<State>[];
};

/** One way a stored record can move, running the real transition. */
export type MachineEvent<
  State,
  EventId extends string,
> = AtlasTrigger<State> & {
  readonly id: EventId;
  /** Whether the engine step behind this event sends real money. */
  readonly movesMoney: boolean;
};

/** A cell that names a node per shape tag rather than one node for all.
 * A tag missing from a split means that shape must refuse. */
export type SplitMove<NodeId extends string> = {
  readonly perRep: Readonly<Partial<Record<string, NodeId>>>;
};

/** Where one event must land: one node for every shape, or a node per
 * shape tag when capability rules split the outcome. */
export type ExpectedMove<NodeId extends string> = NodeId | SplitMove<NodeId>;

/** The declared table: for each node, the events that must move it and
 * where to. Every other (event × shape) pair is thereby a declared
 * refusal, and the sweep still executes it. */
export type MachineMoves<
  NodeId extends string,
  EventId extends string,
> = Readonly<
  Record<NodeId, Readonly<Partial<Record<EventId, ExpectedMove<NodeId>>>>>
>;

const isSplit = <NodeId extends string>(
  move: ExpectedMove<NodeId>,
): move is SplitMove<NodeId> => typeof move === "object";

/** The readers over one declared table: `expected` resolves a cell for one
 * shape ("refused" when absent), and `plain` demands the one answer a cell
 * gives every shape, throwing otherwise. */
export type MachineMovesReader<
  NodeId extends string,
  EventId extends string,
> = {
  readonly expected: (
    node: NodeId,
    event: EventId,
    tag: string,
  ) => NodeId | "refused";
  readonly plain: (node: NodeId, event: EventId) => NodeId;
  /** The shape tags a split cell names; empty for plain or absent cells. */
  readonly splitTags: (node: NodeId, event: EventId) => readonly string[];
  /** Every node one cell can land on; empty when the cell is absent. */
  readonly targets: (node: NodeId, event: EventId) => readonly NodeId[];
};

export const movesIn = <NodeId extends string, EventId extends string>(
  moves: MachineMoves<NodeId, EventId>,
): MachineMovesReader<NodeId, EventId> => {
  /** Answers one cell by what it holds: absent, a plain node, or a split. */
  const readCell = <Out>(
    node: NodeId,
    event: EventId,
    read: {
      readonly absent: () => Out;
      readonly plain: (move: NodeId) => Out;
      readonly split: (move: SplitMove<NodeId>) => Out;
    },
  ): Out => {
    const move: ExpectedMove<NodeId> | undefined = moves[node][event];
    if (move === undefined) return read.absent();
    return isSplit(move) ? read.split(move) : read.plain(move);
  };
  const refusePlain = (node: NodeId, event: EventId): never => {
    throw new Error(`${node} × ${event} does not name one plain move`);
  };
  // The list readers' shared empty answer: an absent cell names nothing.
  const none = (): readonly never[] => [];
  return {
    expected: (node, event, tag) =>
      readCell<NodeId | "refused">(node, event, {
        absent: () => "refused",
        plain: (move) => move,
        // A tag missing from a split is the declared refusal for that shape.
        split: (move) => move.perRep[tag] ?? "refused",
      }),
    plain: (node, event) =>
      readCell<NodeId>(node, event, {
        absent: () => refusePlain(node, event),
        plain: (move) => move,
        split: () => refusePlain(node, event),
      }),
    splitTags: (node, event) =>
      readCell<readonly string[]>(node, event, {
        absent: none,
        plain: none,
        split: (move) => Object.keys(move.perRep),
      }),
    targets: (node, event) =>
      readCell<readonly NodeId[]>(node, event, {
        absent: none,
        plain: (move) => [move],
        split: (move) => compact(Object.values(move.perRep)),
      }),
  };
};

type AtlasStateExtras = Parameters<typeof atlasState>[4];

/** The usual node extras: facts read from the node's first shape, and the
 * start flag on one named node. A node always carries at least one shape,
 * and all of a node's shapes share its lifecycle rule (the graph suites pin
 * both), so the first shape speaks for the whole node. */
export const factsAndStart =
  <State>(
    factsOf: (
      state: State,
    ) => NonNullable<NonNullable<AtlasStateExtras>["facts"]>,
    startId: string,
  ) =>
  (node: MachineNode<State, string>): AtlasStateExtras => ({
    facts: factsOf(node.reps[0]!.state),
    ...(node.id === startId ? { start: true as const } : {}),
  });

/** Where each of a machine's nodes sits on its map. */
export type MachineLayouts<NodeId extends string> = Readonly<
  Record<NodeId, AtlasState["layout"]>
>;

/** The map states of one machine spec: nodes and edges from the spec, so
 * the /admin/schema page and the mirror tests share one source. Layouts and
 * wording keys are the map's own; `extraOf` adds a node's facts and start
 * flag. */
export const atlasStatesFromSpec = <
  State,
  NodeId extends string,
  EventId extends string,
>(
  machine: {
    readonly events: readonly MachineEvent<State, EventId>[];
    readonly nodeOf: (state: State) => NodeId;
    readonly nodes: readonly MachineNode<State, NodeId>[];
  },
  stateKeyPrefix: string,
  layouts: MachineLayouts<NodeId>,
  extraOf: (node: MachineNode<State, NodeId>) => AtlasStateExtras,
): AtlasState[] =>
  machine.nodes.map((node) =>
    atlasState(
      stateKeyPrefix,
      node.id,
      layouts[node.id],
      edgesFromTriggers(
        machine.events,
        machine.nodeOf,
        node.reps.map(({ state }) => state),
      ),
      extraOf(node),
    ),
  );
