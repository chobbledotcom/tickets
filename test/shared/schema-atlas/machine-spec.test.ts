/** The machine-spec framework against a toy machine: the resolver's
 * absent-means-refused contract, split handling, target listing, and the
 * shared atlas builder. The real machines' mirror tests sweep production
 * transitions; this file pins the framework's own edges. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  atlasStatesFromSpec,
  expectedTargets,
  type MachineEvent,
  machineRep,
  movesIn,
} from "#shared/schema-atlas/machine-spec.ts";

// A two-node toy: node "" proves a present value passes through verbatim —
// only an ABSENT cell means refused, even when the stored value is falsy.
type ToyNodeId = "" | "on";
type ToyEventId = "flip" | "halt";

const resolve = movesIn<ToyNodeId, ToyEventId>({
  "": { flip: "on" },
  on: { flip: { perRep: { lit: "" } }, halt: "on" },
}).expected;

describe("the machine-spec framework", () => {
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
      on: { flip: { perRep: { lit: "" } } },
    }).plain;
    expect(plain("", "flip")).toBe("on");
    expect(() => plain("", "halt")).toThrow("does not name one plain move");
    expect(() => plain("on", "flip")).toThrow("does not name one plain move");
  });

  test("expectedTargets lists the plain target or every split target", () => {
    expect(expectedTargets<ToyNodeId>("on")).toEqual(["on"]);
    expect(expectedTargets<ToyNodeId>({ perRep: { a: "", b: "on" } })).toEqual([
      "",
      "on",
    ]);
  });

  test("machineRep pairs a tag with its stored shape", () => {
    expect(machineRep("tag", 7)).toEqual({ state: 7, tag: "tag" });
  });

  test("the atlas builder draws nodes, discovered edges, and extras", () => {
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
    const states = atlasStatesFromSpec(
      {
        events: [flip, halt],
        nodeOf: (state: boolean) => (state ? "on" : ""),
        nodes: [
          { id: "", reps: [machineRep("off", false)] },
          { id: "on", reps: [machineRep("on", true)] },
        ],
      },
      "toy.state",
      { "": { x: 1, y: 2 }, on: { x: 3, y: 4 } },
      ({ id }) => (id === "" ? { start: true as const } : {}),
    );
    expect(states).toEqual([
      {
        detailKey: "toy.state..detail",
        edges: [{ actor: "system", labelKey: "toy.flip", to: "on" }],
        facts: [],
        id: "",
        labelKey: "toy.state.",
        layout: { x: 1, y: 2 },
        start: true,
      },
      {
        detailKey: "toy.state.on.detail",
        edges: [
          { actor: "system", labelKey: "toy.flip", to: "" },
          { actor: "owner", labelKey: "toy.halt", to: "on" },
        ],
        facts: [],
        id: "on",
        labelKey: "toy.state.on",
        layout: { x: 3, y: 4 },
      },
    ]);
  });
});
