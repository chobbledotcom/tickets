import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { driftLines, formatDrift } from "#scripts/contract-drift/diff.ts";
import type {
  DumpedJointState,
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

const contracts = (
  machines: Record<string, DumpedMachine>,
  jointStates: DumpedJointState[] = [],
) => ({ jointStates: jointStates, machines });

/** The drift lines between two versions of machine `m`. */
const driftOf = (before: DumpedMachine, after: DumpedMachine): string[] =>
  driftLines(contracts({ m: before }), contracts({ m: after }));

const armed: DumpedJointState = { authority: "send_armed", rows: ["claim"] };

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

  test("reports joint invariants added and removed", () => {
    const withArmed = contracts({ m: machine() }, [armed]);
    const withoutArmed = contracts({ m: machine() });
    expect(driftLines(withoutArmed, withArmed)).toEqual([
      "+ joint invariant added: send_armed cannot sit on claim",
    ]);
    expect(driftLines(withArmed, withoutArmed)).toEqual([
      "- joint invariant removed: send_armed cannot sit on claim",
    ]);
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
