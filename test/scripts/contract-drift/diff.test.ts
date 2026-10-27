import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { driftLines, formatDrift } from "#scripts/contract-drift/diff.ts";
import type {
  DumpedDeclaredMoves,
  DumpedMachine,
} from "#scripts/contract-drift/dump.ts";

const machine = (over: Partial<DumpedMachine> = {}): DumpedMachine => ({
  edges: {},
  moneyEvents: [],
  start: "a",
  states: ["a"],
  ...over,
});

/** One machine whose single state `a` fires event `e`, by `actor`, to
 * node `to`. */
const movesBy = (actor: string, to: string): DumpedMachine =>
  machine({ edges: { a: [{ actor, event: "e", to }] } });

/** One machine that declares the given table beside its (empty) edges. */
const withTable = (declaredMoves: DumpedDeclaredMoves): DumpedMachine =>
  machine({ declaredMoves });

const contracts = (machines: Record<string, DumpedMachine>) => ({ machines });

/** The drift lines between two versions of machine `m`. */
const driftOf = (before: DumpedMachine, after: DumpedMachine): string[] =>
  driftLines(contracts({ m: before }), contracts({ m: after }));

describe("contract drift lines", () => {
  test("reports nothing when the contracts match", () => {
    expect(driftOf(machine(), machine())).toEqual([]);
  });

  test("reports a machine added and removed", () => {
    const base = contracts({ a: machine() });
    expect(driftLines(base, contracts({ a: machine(), b: machine() }))).toEqual(
      ["+ machine added: b"],
    );
    expect(driftLines(contracts({ a: machine(), b: machine() }), base)).toEqual(
      ["- machine removed: b"],
    );
  });

  test("reports a state added and removed", () => {
    const grown = machine({ states: ["a", "b"] });
    expect(driftOf(machine(), grown)).toEqual(["+ state added: m.b"]);
    expect(driftOf(grown, machine())).toEqual(["- state removed: m.b"]);
  });

  test("reports a moved start", () => {
    expect(driftOf(machine(), machine({ start: "c" }))).toEqual([
      "~ start moved: m.c (was a)",
    ]);
  });

  test("reports a newly allowed move", () => {
    expect(driftOf(machine(), movesBy("system", "b"))).toEqual([
      "+ move allowed: m.a --e--> b",
    ]);
  });

  test("reports a move the head refuses", () => {
    expect(driftOf(movesBy("system", "b"), machine())).toEqual([
      "- move refused: m.a --e--> b",
    ]);
  });

  test("reports a retargeted move one line each way", () => {
    expect(driftOf(movesBy("system", "b"), movesBy("system", "c"))).toEqual([
      "- move refused: m.a --e--> b",
      "+ move allowed: m.a --e--> c",
    ]);
  });

  test("reports an added landing node of a split cell", () => {
    const split = machine({
      edges: {
        a: [
          { actor: "system", event: "e", to: "b" },
          { actor: "system", event: "e", to: "c" },
        ],
      },
    });
    expect(driftOf(movesBy("system", "b"), split)).toEqual([
      "+ move allowed: m.a --e--> c",
    ]);
  });

  test("reports a changed actor", () => {
    expect(driftOf(movesBy("system", "b"), movesBy("owner", "b"))).toEqual([
      "~ actor changed: m.a --e--> now owner (was system)",
    ]);
  });

  test("reports money flags both ways", () => {
    expect(
      driftOf(machine({ moneyEvents: ["e"] }), machine({ moneyEvents: ["f"] })),
    ).toEqual(["- stops moving money: m.e", "+ moves money: m.f"]);
  });

  test("reports a declared table added and removed", () => {
    const table = withTable({ a: { e: "b" } });
    expect(driftOf(machine(), table)).toEqual([
      "+ declared moves table added: m",
    ]);
    expect(driftOf(table, machine())).toEqual([
      "- declared moves table removed: m",
    ]);
  });

  test("reports a node the head table drops, cell by cell", () => {
    expect(
      driftOf(
        withTable({ a: { e: "b" }, gone: { f: "c" } }),
        withTable({ a: { e: "b" } }),
      ),
    ).toEqual(["- declared move refused: m.gone --f--> c"]);
  });

  test("reports a node only the head table has, cell by cell", () => {
    expect(
      driftOf(
        withTable({ a: { e: "b" } }),
        withTable({ a: { e: "b" }, fresh: { g: "c" } }),
      ),
    ).toEqual(["+ declared move allowed: m.fresh --g--> c"]);
  });

  test("reports a declared cell allowed and refused", () => {
    const before = withTable({ a: { e: "b" } });
    const after = withTable({ a: { e: "b", f: "c" } });
    expect(driftOf(before, after)).toEqual([
      "+ declared move allowed: m.a --f--> c",
    ]);
    expect(driftOf(after, before)).toEqual([
      "- declared move refused: m.a --f--> c",
    ]);
  });

  test("reports a retargeted declared cell", () => {
    expect(
      driftOf(withTable({ a: { e: "b" } }), withTable({ a: { e: "c" } })),
    ).toEqual(["~ declared move retargeted: m.a --e--> now c (was b)"]);
  });

  test("reports a changed split cell with its shapes", () => {
    expect(
      driftOf(
        withTable({ a: { e: { perRep: { keyed: "b" } } } }),
        withTable({ a: { e: { perRep: { keyed: "c", keyless: "b" } } } }),
      ),
    ).toEqual([
      "~ declared move retargeted: m.a --e--> now perRep {keyed: c, keyless: b} (was perRep {keyed: b})",
    ]);
  });

  test("reports nothing when the declared tables match", () => {
    expect(
      driftOf(
        withTable({ a: { e: { perRep: { keyed: "b" } } } }),
        withTable({ a: { e: { perRep: { keyed: "b" } } } }),
      ),
    ).toEqual([]);
  });
});

describe("contract drift report", () => {
  test("prints the clean sentence when nothing moved", () => {
    expect(
      formatDrift(
        contracts({ m: machine() }),
        contracts({ m: machine() }),
        "origin/main",
      ),
    ).toBe("No contract drift against origin/main.");
  });

  test("prints declared moves between the executed ones and the money flags", () => {
    const before = {
      ...movesBy("system", "b"),
      declaredMoves: { a: { e: "b" } },
    };
    const after = {
      ...movesBy("system", "c"),
      declaredMoves: { a: { e: "d" } },
    };
    expect(
      formatDrift(contracts({ m: before }), contracts({ m: after }), "x"),
    ).toBe(
      "Contract drift against x: 3 change(s)\n\n" +
        "- move refused: m.a --e--> b\n" +
        "+ move allowed: m.a --e--> c\n" +
        "~ declared move retargeted: m.a --e--> now d (was b)",
    );
  });

  test("prints the header and every change", () => {
    const grown = machine({
      edges: { a: [{ actor: "system", event: "e", to: "b" }] },
      moneyEvents: ["e"],
      states: ["a", "b"],
    });
    expect(
      formatDrift(
        contracts({ m: machine() }),
        contracts({ m: grown }),
        "origin/main",
      ),
    ).toBe(
      "Contract drift against origin/main: 3 change(s)\n\n" +
        "+ state added: m.b\n" +
        "+ move allowed: m.a --e--> b\n" +
        "+ moves money: m.e",
    );
  });
});
