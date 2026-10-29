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
 * events. Returns the number of from-state and event keys it checked, so
 * the sweep's caller can tell an empty walk from a real one. */
const checkCells = (
  machine: DumpedMachine,
  events: ReadonlySet<string>,
): number => {
  let checked = 0;
  for (const [from, cells] of Object.entries(machine.declaredMoves ?? {})) {
    assertArrayIncludes(machine.states, [from], `cells from ${from}`);
    checked += 1;
    for (const [event, cell] of Object.entries(cells)) {
      assertArrayIncludes([...events], [event], `${from} --${event}-->`);
      checked += 1;
      for (const to of targetsOf(cell)) {
        assertArrayIncludes(
          machine.states,
          [to],
          `${from} --${event}--> ${to}`,
        );
      }
    }
  }
  return checked;
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
      "vat",
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
    let checked = 0;
    for (const machine of Object.values((await currentContracts()).machines)) {
      const events = new Set(
        Object.values(machine.edges)
          .flat()
          .map((edge) => edge.event),
      );
      checked += checkCells(machine, events);
    }
    // A sweep that walks nothing proves nothing, so the atlas's machines
    // must actually carry declared cells.
    expect(checked).toBeGreaterThan(0);
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
    // The machine's own shape dumps whole; only the table is absent.
    expect(dumped.declaredMoves).toEqual(undefined);
    expect(dumped.start).toBe(state.id);
    expect(dumped.states).toEqual([state.id]);
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
      await declaredTableOrNone(
        "m",
        () => {
          throw new TypeError(
            'Module not found "file:///tree/test/shared/payment/m/expected-moves.ts"',
          );
        },
        "#test/shared/payment/m/expected-moves.ts",
      ),
    ).toEqual(undefined);
  });

  test("reads a bare quoted specifier as no table too", async () => {
    expect(
      await declaredTableOrNone(
        "m",
        () => {
          throw new TypeError(
            'Module not found "#test/shared/payment/m/expected-moves.ts"',
          );
        },
        "#test/shared/payment/m/expected-moves.ts",
      ),
    ).toEqual(undefined);
  });

  test("reads a module the real loader cannot find as no table", async () => {
    // The synthetic errors above pin the matcher's logic; this one pins the
    // agreement to the runtime: Deno's own not-found error for a mapped
    // specifier must carry the bare path the matcher looks for.
    const specifier = "#test/shared/payment/m/no-such-table-module.ts";
    let failure: TypeError | undefined;
    try {
      await import(specifier);
    } catch (error) {
      failure = error instanceof TypeError ? error : undefined;
    }
    expect(failure?.message).toContain(specifier.replace(/^#/, ""));
    expect(
      await declaredTableOrNone("m", () => import(specifier), specifier),
    ).toEqual(undefined);
  });

  test("hands every test-module table load its own specifier", async () => {
    // The specifier must name the very module the load imports, or the base
    // dump misreads a missing table (or a break one level below it, issue
    // #2740). The load keeps a literal import — a variable specifier would
    // ask the base-dump child for read permission it does not hold — so this
    // holds the two spellings together: each test-module specifier appears
    // exactly twice, once in its import and once as the load's module name.
    const source = await Deno.readTextFile("scripts/contract-drift/dump.ts");
    const loads = [...source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)]
      .map((match) => match[1])
      .filter((specifier): specifier is string => specifier !== undefined)
      .filter((specifier) => specifier.startsWith("#test/"));
    expect(loads.length).toBeGreaterThan(0);
    for (const specifier of loads) {
      const spellings = source.split(`"${specifier}"`).length - 1;
      expect(
        spellings,
        `"${specifier}" must appear twice: in its import and as the load's module name`,
      ).toBe(2);
    }
  });

  test("stops when a module one level below the table is missing", async () => {
    await expect(
      declaredTableOrNone(
        "m",
        () => {
          throw new TypeError(
            'Module not found "file:///tree/test/shared/payment/m/its-helper.ts"',
          );
        },
        "#test/shared/payment/m/expected-moves.ts",
      ),
    ).rejects.toThrow("its-helper.ts");
  });

  test("stops on a missing module when the load names no specifier", async () => {
    await expect(
      declaredTableOrNone("m", () => {
        throw new TypeError(
          'Module not found "file:///tree/test/shared/payment/m/expected-moves.ts"',
        );
      }),
    ).rejects.toThrow("Module not found");
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
