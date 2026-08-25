/** The machine-spec framework against a toy machine: the resolver's
 * absent-means-refused contract, split handling, target listing, the
 * derived node lists, and the shared atlas builder. The real machines'
 * mirror tests sweep production transitions; this file pins the
 * framework's own edges. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  atlasMachineFrom,
  derivedNodeIds,
  factsAndStart,
  factsFromNode,
  type MachineEvent,
  machineRep,
  movesIn,
  nodeIdsWhere,
} from "#shared/schema-atlas/machine-spec.ts";

// A three-node toy: node "" proves a present value passes through verbatim —
// only an ABSENT cell means refused, even when the stored value is falsy —
// and "end" is the node no cell moves.
type ToyNodeId = "" | "end" | "on";
type ToyEventId = "flip" | "halt";

const TOY_MOVES = {
  "": { flip: "on" },
  end: {},
  on: { flip: { perRep: { lit: "" } }, halt: "on" },
} as const;

const TOY_TABLE = {
  events: [
    { id: "flip", kind: "toggle" },
    { id: "halt", kind: "stop" },
  ] as const,
  moves: TOY_MOVES,
  nodes: [
    { id: "", reps: [machineRep("off", false)] },
    { id: "on", reps: [machineRep("on", true)] },
    { id: "end", reps: [machineRep("done", true)] },
  ],
} as const;

const reader = movesIn<ToyNodeId, ToyEventId>(TOY_MOVES);
const resolve = reader.expected;

describe("the machine-spec framework", () => {
  test("factsAndStart reads the first shape and flags only the start node", () => {
    const extras = factsAndStart(
      (state: boolean) => [
        { labelKey: "toy.fact", value: state ? "lit" : "dark" },
      ],
      "on",
    );
    // Two shapes: the FIRST speaks for the node, and a non-start node
    // carries no start flag.
    expect(
      extras({
        id: "",
        reps: [machineRep("off", false), machineRep("dim", true)],
      }),
    ).toEqual({ facts: [{ labelKey: "toy.fact", value: "dark" }] });
    expect(extras({ id: "on", reps: [machineRep("on", true)] })).toEqual({
      facts: [{ labelKey: "toy.fact", value: "lit" }],
      start: true,
    });
  });

  test("factsFromNode reads the node itself and flags only the start node", () => {
    const extras = factsFromNode(
      (node: { id: string; kept: string; reps: never[] }) => [
        { labelKey: "toy.kept", value: node.kept },
      ],
      "on",
    );
    expect(extras({ id: "", kept: "for a day", reps: [] })).toEqual({
      facts: [{ labelKey: "toy.kept", value: "for a day" }],
    });
    expect(extras({ id: "on", kept: "forever", reps: [] })).toEqual({
      facts: [{ labelKey: "toy.kept", value: "forever" }],
      start: true,
    });
  });

  test("nodeIdsWhere keeps declaration order and only matching nodes", () => {
    expect(nodeIdsWhere(TOY_TABLE.nodes, (node) => node.id !== "on")).toEqual([
      "",
      "end",
    ]);
    expect(nodeIdsWhere(TOY_TABLE.nodes, () => false)).toEqual([]);
  });

  test("movedBy answers from the cells the matching events name", () => {
    // A split cell still moves its node, and the event filter is real: only
    // "on" has a halt cell, while flip moves both non-terminal nodes.
    const derived = derivedNodeIds(TOY_TABLE);
    expect(derived.movedBy((event) => event.kind === "stop")).toEqual(["on"]);
    expect(derived.movedBy((event) => event.kind === "toggle")).toEqual([
      "",
      "on",
    ]);
    expect(derived.movedBy(() => false)).toEqual([]);
  });

  test("terminal names exactly the nodes no cell moves", () => {
    expect(derivedNodeIds(TOY_TABLE).terminal()).toEqual(["end"]);
  });

  test("a plain cell names the move for every shape", () => {
    expect(resolve("", "flip", "anything")).toBe("on");
  });

  test("an absent cell is the declared refusal", () => {
    expect(resolve("", "halt", "anything")).toBe("refused");
  });

  test("a split cell moves only the shapes it names", () => {
    expect(resolve("on", "flip", "lit")).toBe("");
    expect(resolve("on", "flip", "unlit")).toBe("refused");
  });

  test("a falsy node id is a real destination, never a refusal", () => {
    // The distinguishing input: "" is present in the split, so it must be
    // returned as-is — a refusal is only ever the absence of a cell.
    expect(resolve("on", "flip", "lit")).toBe("");
    expect(resolve("on", "flip", "lit")).not.toBe("refused");
  });

  test("a plain resolver answers plain cells and refuses the rest", () => {
    const plain = movesIn<ToyNodeId, ToyEventId>({
      "": { flip: "on" },
      end: {},
      on: { flip: { perRep: { lit: "" } } },
    }).plain;
    expect(plain("", "flip")).toBe("on");
    expect(() => plain("", "halt")).toThrow("does not name one plain move");
    expect(() => plain("on", "flip")).toThrow("does not name one plain move");
  });

  test("targets lists the plain target, every split target, or nothing", () => {
    expect(reader.targets("", "flip")).toEqual(["on"]);
    expect(reader.targets("on", "flip")).toEqual([""]);
    expect(reader.targets("", "halt")).toEqual([]);
  });

  test("splitTags names a split's shapes and nothing else", () => {
    expect(reader.splitTags("on", "flip")).toEqual(["lit"]);
    expect(reader.splitTags("", "flip")).toEqual([]);
    expect(reader.splitTags("", "halt")).toEqual([]);
  });

  test("machineRep pairs a tag with its stored shape", () => {
    expect(machineRep("tag", 7)).toEqual({ state: 7, tag: "tag" });
  });

  test("the atlas builder draws nodes, discovered edges, and its own keys", () => {
    // A one-bit machine: flipping toggles, halting only works when on.
    const flip: MachineEvent<boolean, ToyEventId> = {
      actor: "system",
      id: "flip",
      labelKey: "toy.flip",
      movesMoney: false,
      run: (state) => !state,
    };
    const halt: MachineEvent<boolean, ToyEventId> = {
      actor: "owner",
      id: "halt",
      labelKey: "toy.halt",
      movesMoney: false,
      run: (state) => {
        if (!state) throw new Error("Only an on machine can halt");
        return state;
      },
    };
    const machine = atlasMachineFrom(
      {
        events: [flip, halt],
        nodeOf: (state: boolean) => (state ? "on" : ""),
        nodes: [
          { id: "", reps: [machineRep("off", false)] },
          { id: "on", reps: [machineRep("on", true)] },
        ],
      },
      {
        extraOf: ({ id }) => (id === "" ? { start: true as const } : {}),
        id: "toy",
        layouts: { "": { x: 1, y: 2 }, on: { x: 3, y: 4 } },
      },
    );
    expect(machine).toEqual({
      id: "toy",
      introKey: "schema.toy.intro",
      states: [
        {
          detailKey: "schema.toy.state..detail",
          edges: [{ actor: "system", labelKey: "toy.flip", to: "on" }],
          facts: [],
          id: "",
          labelKey: "schema.toy.state.",
          layout: { x: 1, y: 2 },
          start: true,
        },
        {
          detailKey: "schema.toy.state.on.detail",
          edges: [
            { actor: "system", labelKey: "toy.flip", to: "" },
            { actor: "owner", labelKey: "toy.halt", to: "on" },
          ],
          facts: [],
          id: "on",
          labelKey: "schema.toy.state.on",
          layout: { x: 3, y: 4 },
        },
      ],
      titleKey: "schema.toy.title",
    });
  });
});
