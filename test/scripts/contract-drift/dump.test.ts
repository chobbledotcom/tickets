import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  contractsFromAtlas,
  currentContracts,
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

  test("refuses a machine the events table does not know", async () => {
    await expect(contractsFromAtlas([machineWith([])])).rejects.toThrow(
      "Machine m joined the atlas; the drift dump must learn its events",
    );
  });

  test("refuses an edge without an event", () => {
    const state = oneState("schema.m.edge.unknown", true);
    expect(() => dumpMachine(machineWith([state]), [oneEvent])).toThrow(
      "No machine event carries the label key schema.m.edge.unknown",
    );
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
