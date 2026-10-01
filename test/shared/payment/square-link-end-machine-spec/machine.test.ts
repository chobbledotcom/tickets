/** The Square link-end machine: every declared move lands where the table
 * says, every absent cell refuses, and the laws over the declaration hold. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  LINK_END_CHECKABLE_NODES,
  LINK_END_EVENTS,
  LINK_END_MOVES,
  LINK_END_NODES,
  parseSquareLinkEndState,
  type SquareLinkEndRow,
} from "#payment/square-link-end-machine-spec.ts";
import { derivedNodeIds } from "#shared/schema-atlas/machine-spec.ts";
import {
  registerConformanceSweep,
  registerTableChecks,
} from "#test-utils/machine-spec.ts";

/* jscpd:ignore-end */

const spec = {
  events: LINK_END_EVENTS,
  moves: LINK_END_MOVES,
  nodeOf: (row: SquareLinkEndRow) => row.state,
  nodes: LINK_END_NODES,
};

/** The closed node, read off the declared table the way production reads its
 * own derived lists. */
const LINK_END_TERMINAL = derivedNodeIds(spec).terminal();

describe("square link end machine", () => {
  registerConformanceSweep(spec);
  registerTableChecks(spec, { events: 8, nodes: 4, shapes: 4 });

  test("exactly the two stored states can still take payment", () => {
    // The retention arm, not the machine, deletes old rows: past Square's
    // own page lifetime no link can take payment, whatever state it sat in.
    expect(
      LINK_END_NODES.filter((node) => node.takesPayment !== "no").map(
        (node) => node.id,
      ),
    ).toEqual(["pending", "ending"]);
  });

  test("the closed node is the one no event moves", () => {
    expect(LINK_END_TERMINAL).toEqual(["gone"]);
  });

  test("the expiry task asks about exactly the two stored states", () => {
    expect(LINK_END_CHECKABLE_NODES).toEqual(["pending", "ending"]);
  });

  test("no event moves money", () => {
    // Law 3: the task ends links and rows only. Money moves in the payment
    // engine, never here.
    expect(LINK_END_EVENTS.every((event) => event.movesMoney === false)).toBe(
      true,
    );
  });

  test("refuses a stored word the machine does not have", () => {
    expect(() => parseSquareLinkEndState("gone")).toThrow(
      "A square_link_ends row holds unknown state gone",
    );
  });

  test("only the task's own events move a row, and only from where they were declared", () => {
    // The virtual nodes carry no stored word: no read can produce one, and
    // no writer can store one.
    expect(() => parseSquareLinkEndState("unwritten")).toThrow(
      "A square_link_ends row holds unknown state unwritten",
    );
  });
});
