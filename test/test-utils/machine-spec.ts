/** Shared executors for machine-spec mirror tests: the conformance sweep
 * and the table-shape checks every machine runs the same way. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type ExpectedMove,
  expectedTargets,
  type MachineEvent,
  type MachineMoves,
  type MachineNode,
  type MachineRepresentative,
  movesIn,
} from "#shared/schema-atlas/machine-spec.ts";

/** Everything one machine's mirror test hands the shared executors. */
export type MachineSpec<
  State,
  NodeId extends string,
  EventId extends string,
> = {
  readonly events: readonly MachineEvent<State, EventId>[];
  readonly moves: MachineMoves<NodeId, EventId>;
  readonly nodeOf: (state: State) => NodeId;
  readonly nodes: readonly MachineNode<State, NodeId>[];
};

/** Runs one cell and asserts the exact move the table declares for it. */
const checkCell = <State, NodeId extends string, EventId extends string>(
  spec: MachineSpec<State, NodeId, EventId>,
  node: MachineNode<State, NodeId>,
  event: MachineEvent<State, EventId>,
  rep: MachineRepresentative<State>,
): void => {
  const cell = `${node.id} × ${event.id} [${rep.tag}]`;
  const want = movesIn(spec.moves).expected(node.id, event.id, rep.tag);
  if (want === "refused") {
    expectRefusal(() => event.run(rep.state), cell);
  } else {
    expect(spec.nodeOf(event.run(rep.state)), cell).toBe(want);
  }
};

/** A refusal must be an Error that says why — a blank refusal would leave
 * an operator with nothing to act on. */
const expectRefusal = (run: () => unknown, cell: string): void => {
  let refusal: unknown = null;
  try {
    run();
  } catch (error) {
    refusal = error;
  }
  expect(refusal instanceof Error, `${cell} must refuse`).toBe(true);
  if (refusal instanceof Error) {
    expect(
      refusal.message.length,
      `${cell} refusal must say why`,
    ).toBeGreaterThan(0);
  }
};

/** Registers one test per node: every event runs against every one of its
 * shapes and must land where the table says — or throw, when the cell is
 * absent. Call inside a describe. */
export const registerConformanceSweep = <
  State,
  NodeId extends string,
  EventId extends string,
>(
  spec: MachineSpec<State, NodeId, EventId>,
): void => {
  for (const node of spec.nodes) {
    test(`${node.id} answers every event for each of its shapes`, () => {
      let executed = 0;
      for (const event of spec.events) {
        for (const rep of node.reps) {
          executed++;
          checkCell(spec, node, event, rep);
        }
      }
      expect(executed).toBe(spec.events.length * node.reps.length);
    });
  }
};

/** The whole-table size, pinned so a silently shrunk shape family or event
 * list cannot pass as "all cells still conform". */
export type MachinePins = {
  readonly events: number;
  readonly nodes: number;
  readonly shapes: number;
};

const tableEntries = <NodeId extends string, EventId extends string>(
  moves: MachineMoves<NodeId, EventId>,
  node: NodeId,
): readonly [string, ExpectedMove<NodeId>][] =>
  Object.entries(moves[node]).filter(
    (entry): entry is [string, ExpectedMove<NodeId>] => entry[1] !== undefined,
  );

/** Registers the table-shape checks shared by every machine: pinned sizes,
 * shapes sitting on their own node, real targets, and split cells naming
 * only shapes their node has. Call inside a describe. */
export const registerTableChecks = <
  State,
  NodeId extends string,
  EventId extends string,
>(
  spec: MachineSpec<State, NodeId, EventId>,
  pins: MachinePins,
): void => {
  test(`the sweep's size is pinned: ${pins.nodes} nodes × ${pins.events} events over ${pins.shapes} shapes`, () => {
    expect(spec.nodes.length).toBe(pins.nodes);
    expect(spec.events.length).toBe(pins.events);
    expect(
      spec.nodes.reduce((total, node) => total + node.reps.length, 0),
    ).toBe(pins.shapes);
    const eventIds = spec.events.map(({ id }) => id);
    expect([...new Set(eventIds)]).toEqual(eventIds);
  });

  test("every shape sits on the node it stands for", () => {
    for (const node of spec.nodes) {
      const tags = node.reps.map(({ tag }) => tag);
      expect([...new Set(tags)], node.id).toEqual(tags);
      for (const { state, tag } of node.reps) {
        expect(spec.nodeOf(state), `${node.id} [${tag}]`).toBe(node.id);
      }
    }
  });

  test("the table answers exactly the declared nodes with real targets", () => {
    const nodeIds = spec.nodes.map(({ id }) => id);
    expect([...new Set(nodeIds)]).toEqual(nodeIds);
    expect(Object.keys(spec.moves).sort()).toEqual([...nodeIds].sort());
    const known = new Set<string>(nodeIds);
    for (const node of spec.nodes) {
      for (const [eventId, move] of tableEntries(spec.moves, node.id)) {
        for (const target of expectedTargets(move)) {
          expect(
            known.has(target),
            `${node.id} × ${eventId} -> ${target}`,
          ).toBe(true);
        }
      }
    }
  });

  test("a split cell names only shapes its node actually has", () => {
    for (const node of spec.nodes) {
      const tags = new Set(node.reps.map(({ tag }) => tag));
      for (const [eventId, move] of tableEntries(spec.moves, node.id)) {
        if (typeof move === "string") continue;
        for (const tag of Object.keys(move.perRep)) {
          expect(
            tags.has(tag),
            `${node.id} × ${eventId} splits on unknown [${tag}]`,
          ).toBe(true);
        }
      }
    }
  });
};
