/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  LINK_END_EVENTS,
  LINK_END_MOVES,
  LINK_END_NODES,
} from "#payment/square-link-end-machine-spec.ts";
import { derivedNodeIds, movesIn } from "#shared/schema-atlas/machine-spec.ts";
import { machineGraph } from "#test-utils/machine-graph.ts";

/* jscpd:ignore-end */

const graph = machineGraph({
  events: LINK_END_EVENTS,
  label: "square link end",
  nodes: LINK_END_NODES,
  targets: movesIn(LINK_END_MOVES).targets,
});

/** The closed node, read off the declared table the way production reads its
 * own derived lists. */
const LINK_END_TERMINAL = derivedNodeIds({
  events: LINK_END_EVENTS,
  moves: LINK_END_MOVES,
  nodes: LINK_END_NODES,
}).terminal();

describe("square link end machine graph", () => {
  test("every node is reachable from a row that does not exist yet", () => {
    expect(graph.reachableFrom("unwritten")).toEqual(
      new Set(["ending", "gone", "pending", "unwritten"]),
    );
  });

  test("every node can still reach the row's end", () => {
    for (const node of ["unwritten", "pending", "ending"] as const) {
      expect(graph.reachableFrom(node).has("gone")).toBe(true);
    }
  });

  test("a gone row has no way back out", () => {
    expect([...LINK_END_TERMINAL]).toEqual(["gone"]);
    expect(graph.successors("gone")).toEqual([]);
  });
});
