/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  RECOVERY_EVENTS,
  RECOVERY_MOVES,
  RECOVERY_NODES,
  RECOVERY_TERMINAL_NODES,
  type RecoveryNodeId,
  recoveryMoveTo,
  recoveryNodeOf,
  recoveryRowAfter,
} from "#payment/sumup-recovery-machine-spec.ts";
import { movesIn } from "#shared/schema-atlas/machine-spec.ts";
import { machineGraph } from "#test-utils/machine-graph.ts";

/* jscpd:ignore-end */

const graph = machineGraph({
  events: RECOVERY_EVENTS,
  label: "sumup recovery",
  nodes: RECOVERY_NODES,
  targets: movesIn(RECOVERY_MOVES).targets,
});

describe("sumup recovery machine graph", () => {
  test("every node is reachable from a freshly staged row", () => {
    const reached = graph.reachableFrom("staged");
    for (const node of RECOVERY_NODES) {
      expect(reached.has(node.id), `${node.id} is unreachable`).toBe(true);
    }
  });

  test("every node can still reach a closed answer", () => {
    for (const node of RECOVERY_NODES) {
      const reached = graph.reachableFrom(node.id);
      const closes = RECOVERY_TERMINAL_NODES.some((id) => reached.has(id));
      expect(closes, `${node.id} can never be closed`).toBe(true);
    }
  });

  test("a closed row has no way back out", () => {
    for (const id of RECOVERY_TERMINAL_NODES) {
      expect([...graph.reachableFrom(id)], id).toEqual([id]);
    }
  });
});

describe("recoveryNodeOf", () => {
  test("reads a staged row from its missing checkout id", () => {
    expect(recoveryNodeOf({ recoveryState: "staged", sumupId: "" })).toBe(
      "staged",
    );
  });

  for (const state of ["waiting", "owed", "unpaid", "finished"] as const) {
    test(`reads a ${state} row from its checkout id`, () => {
      expect(recoveryNodeOf({ recoveryState: state, sumupId: "chk_1" })).toBe(
        state,
      );
    });
  }

  test("refuses a staged row that already has a checkout id", () => {
    expect(() =>
      recoveryNodeOf({ recoveryState: "staged", sumupId: "chk_1" }),
    ).toThrow("cannot be staged with a checkout id");
  });

  test("refuses a checked row that has no checkout id", () => {
    expect(() =>
      recoveryNodeOf({ recoveryState: "owed", sumupId: "" }),
    ).toThrow("cannot be owed with no checkout id");
  });
});

describe("recoveryMoveTo", () => {
  test("names the row and the event it refused", () => {
    expect(() => recoveryMoveTo("finished", "read_paid_booked")).toThrow(
      "A finished SumUp checkout refuses read_paid_booked",
    );
  });

  test("gives a created checkout its id and its live state at once", () => {
    expect(
      recoveryRowAfter(
        { recoveryState: "staged", sumupId: "" },
        "checkout_created",
        "chk_new",
      ),
    ).toEqual({ recoveryState: "waiting", sumupId: "chk_new" });
  });

  test("refuses to create a checkout that was given no id", () => {
    // The move would leave a waiting row with no id — a shape no reader
    // accepts, so it is raised here rather than written.
    expect(() =>
      recoveryRowAfter(
        { recoveryState: "staged", sumupId: "" },
        "checkout_created",
        "",
      ),
    ).toThrow("cannot be waiting with no checkout id");
  });

  test("keeps the checkout id on every later move", () => {
    const moved: RecoveryNodeId = recoveryMoveTo(
      "waiting",
      "read_paid_unsettled",
    );
    expect(moved).toBe("owed");
    expect(
      recoveryRowAfter(
        { recoveryState: "waiting", sumupId: "chk_kept" },
        "read_paid_unsettled",
        "chk_ignored",
      ),
    ).toEqual({ recoveryState: "owed", sumupId: "chk_kept" });
  });
});
