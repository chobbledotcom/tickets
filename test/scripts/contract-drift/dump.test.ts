import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  contractsFromAtlas,
  currentContracts,
  type DumpedDeclaredMoves,
  type DumpedMachine,
  type DumpedMoveCell,
  declaredTableOrNone,
  dumpMachine,
} from "#scripts/contract-drift/dump.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  type AtlasMachine,
  type AtlasState,
  atlasState,
} from "#shared/schema-atlas/types.ts";

const oneState = (labelKey: string, start: true | undefined): AtlasState =>
  atlasState(
    "schema.m.state",
    "a",
    { x: 0, y: 0 },
    [{ actor: "system", labelKey, to: "a" }],
    start === undefined ? {} : { start },
  );

const machineWith = (states: readonly AtlasState[]): AtlasMachine => ({
  id: "m",
  introKey: "schema.m.intro",
  states,
  titleKey: "schema.m.title",
});

const oneEvent = {
  id: "e",
  labelKey: "schema.m.edge.e",
  movesMoney: false,
};

/** The nodes one declared cell allows. */
const targetsOf = (cell: DumpedMoveCell): readonly string[] =>
  typeof cell === "string" ? [cell] : Object.values(cell.perRep);

/** One machine's declared cells must stay inside its own states and
 * events. */
const checkCells = (
  machine: DumpedMachine,
  events: ReadonlySet<string>,
): void => {
  for (const [from, cells] of Object.entries(machine.declaredMoves ?? {})) {
    expect(machine.states, `cells from ${from}`).toContain(from);
    for (const [event, cell] of Object.entries(cells)) {
      expect([...events], `${from} --${event}-->`).toContain(event);
      for (const to of targetsOf(cell)) {
        expect(machine.states, `${from} --${event}--> ${to}`).toContain(to);
      }
    }
  }
};

describe("contract dump", () => {
  test("dumps every machine the atlas maps", async () => {
    const dump = await currentContracts();
    expect(Object.keys(dump.machines)).toEqual([
      "refund",
      "review",
      "row",
      "square_link_ends",
      "sumup_recovery",
    ]);
  });

  test("pins the refund contract", async () => {
    const dump = await currentContracts();
    const refund = requireValue(
      dump.machines.refund,
      "refund machine in the dump",
    );
    expect(refund.start).toBe("ready");
    expect(refund.moneyEvents).toEqual(["arm", "replay"]);
    expect(refund.states).toEqual([
      "check",
      "choice_not_sent",
      "choice_open",
      "choice_returned",
      "observing",
      "ready",
      "recorded",
      "returned",
      "send_armed",
    ]);
    expect(refund.edges.ready).toContainEqual({
      actor: "system",
      event: "arm",
      to: "send_armed",
    });
  });

  test("pins the row, review, and sumup contracts", async () => {
    const machines = (await currentContracts()).machines;
    const row = requireValue(machines.row, "row machine in the dump");
    const review = requireValue(machines.review, "review machine in the dump");
    const sumup = requireValue(
      machines.sumup_recovery,
      "sumup_recovery machine in the dump",
    );
    expect(row.start).toBe("free");
    expect(row.moneyEvents).toEqual([]);
    expect(row.edges.free).toContainEqual({
      actor: "system",
      event: "claim_granted",
      to: "claim",
    });
    expect(review.start).toBe("none");
    expect(review.moneyEvents).toEqual([]);
    expect(sumup.start).toBe("staged");
    expect(sumup.moneyEvents).toEqual([
      "read_paid_settled",
      "read_paid_unsettled",
    ]);
  });

  test("keeps every edge inside its machine's states", async () => {
    for (const machine of Object.values((await currentContracts()).machines)) {
      for (const [from, edges] of Object.entries(machine.edges)) {
        assertArrayIncludes(machine.states, [from], `edges from ${from}`);
        for (const edge of edges) {
          assertArrayIncludes(
            machine.states,
            [edge.to],
            `${from} --${edge.event}-->`,
          );
        }
      }
    }
  });

  test("dumps the declared joint states", async () => {
    expect((await currentContracts()).jointStates).toEqual([
      {
        authority: "absent",
        rows: [
          "claim",
          "claim_review",
          "claim_review_unrecorded",
          "claim_unrecorded",
        ],
      },
      {
        authority: "send_armed",
        rows: [
          "free_finalized",
          "free_reserved",
          "review",
          "review_unrecorded",
          "settled",
          "unrecorded",
        ],
      },
    ]);
  });

  test("refuses a machine the loaders do not know", async () => {
    await expect(contractsFromAtlas([machineWith([])])).rejects.toThrow(
      "Machine m joined the atlas; the drift dump must learn its events and declared moves",
    );
  });

  test("dumps every machine's declared table", async () => {
    const machines = (await currentContracts()).machines;
    const declared = (id: string) =>
      requireValue(machines[id], `${id} machine in the dump`).declaredMoves;
    expect(declared("refund")?.ready).toEqual({
      arm: "send_armed",
      conflict_not_sent: "choice_not_sent",
      conflict_returned: "choice_returned",
      conflict_wait: "check",
      provider_returned: "returned",
      unreadable: "choice_open",
    });
    expect(declared("review")?.open).toEqual({
      acknowledge: "seen",
      retire_partially_returned_obligation: {
        perRep: { partially_returned_obligation: "none" },
      },
      retire_shared_reference: { perRep: { shared_reference: "none" } },
    });
    expect(declared("row")?.settled).toEqual({ write_outcome: "settled" });
    expect(declared("square_link_ends")?.pending).toEqual({
      claim_due: "ending",
      payment_completed: "gone",
    });
    expect(declared("sumup_recovery")?.waiting).toEqual({
      read_expired_or_failed: "unpaid",
      read_paid_booked: "finished",
      read_paid_contradiction: "owed",
      read_paid_settled: "finished",
      read_paid_unreadable: "waiting",
      read_paid_unsettled: "owed",
      read_pending: "waiting",
      read_unavailable: "waiting",
    });
  });

  test("keeps every declared cell inside its machine's states and events", async () => {
    for (const machine of Object.values((await currentContracts()).machines)) {
      const events = new Set(
        Object.values(machine.edges)
          .flat()
          .map((edge) => edge.event),
      );
      checkCells(machine, events);
    }
  });

  test("refuses an edge without an event", () => {
    const state = oneState("schema.m.edge.unknown", true);
    expect(() => dumpMachine(machineWith([state]), [oneEvent])).toThrow(
      "No machine event carries the label key schema.m.edge.unknown",
    );
  });

  test("sorts the declared table's keys", () => {
    const state = oneState("schema.m.edge.e", true);
    // The keys go in backwards, so the sort has to swap a pair.
    const table: DumpedDeclaredMoves = {
      a: { z: { perRep: { keyed: "a", keyless: "a" } } },
      b: { a: "a", z: "a" },
    };
    const backwards = Object.fromEntries(Object.entries(table).reverse());
    const dumped = dumpMachine(machineWith([state]), [oneEvent], backwards);
    const declared = requireValue(dumped.declaredMoves, "declared moves");
    expect(Object.keys(declared)).toEqual(["a", "b"]);
    expect(Object.keys(declared.b ?? {})).toEqual(["a", "z"]);
    expect(declared.a?.z).toEqual({
      perRep: { keyed: "a", keyless: "a" },
    });
  });

  test("dumps no declared table when the machine has none", () => {
    const state = oneState("schema.m.edge.e", true);
    const dumped = dumpMachine(machineWith([state]), [oneEvent]);
    expect(dumped.declaredMoves).toBeUndefined();
  });

  test("refuses a machine with no start", () => {
    const state = oneState("schema.m.edge.e", undefined);
    expect(() => dumpMachine(machineWith([state]), [oneEvent])).toThrow(
      "Machine m must declare exactly one start",
    );
  });

  test("refuses a machine with two starts", () => {
    const states = [
      oneState("schema.m.edge.e", true),
      oneState("schema.m.edge.e", true),
    ];
    expect(() => dumpMachine(machineWith(states), [oneEvent])).toThrow(
      "Machine m must declare exactly one start",
    );
  });
});

describe("declaredTableOrNone", () => {
  const load = (value: unknown) => () => value;

  test("validates and returns the machine's table", async () => {
    expect(await declaredTableOrNone("m", load({ a: { e: "b" } }))).toEqual({
      a: { e: "b" },
    });
  });

  test("reads a table module the tree does not have as no table", async () => {
    expect(
      await declaredTableOrNone("m", () => {
        throw new TypeError(
          'Module not found "file:///tree/expected-moves.ts"',
        );
      }),
    ).toBeUndefined();
  });

  test("stops on a failure that is not a missing module", async () => {
    await expect(
      declaredTableOrNone("m", () => {
        throw new Error("the table module is broken");
      }),
    ).rejects.toThrow("the table module is broken");
  });

  test("stops when the table is not the dumped shape", async () => {
    await expect(
      declaredTableOrNone("m", load({ a: { e: 42 } })),
    ).rejects.toThrow("Machine m's declared table is not the dumped shape");
  });
});
