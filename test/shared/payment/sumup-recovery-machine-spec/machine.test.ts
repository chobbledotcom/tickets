/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseSumupRecoveryState,
  RECOVERY_CHECKABLE_NODES,
  RECOVERY_EVENTS,
  RECOVERY_MOVES,
  RECOVERY_NODES,
  RECOVERY_PRUNABLE_NODES,
  RECOVERY_TERMINAL_NODES,
  RECOVERY_UNANSWERED_NODES,
  RECOVERY_UNANSWERED_WHEN_OLD_NODES,
  type RecoveryNodeId,
  recoveryNodeOf,
} from "#payment/sumup-recovery-machine-spec.ts";
import { movesIn } from "#shared/schema-atlas/machine-spec.ts";
import {
  registerConformanceSweep,
  registerTableChecks,
} from "#test-utils/machine-spec.ts";

/* jscpd:ignore-end */

const spec = {
  events: RECOVERY_EVENTS,
  moves: RECOVERY_MOVES,
  nodeOf: recoveryNodeOf,
  nodes: RECOVERY_NODES,
};

const reader = movesIn(RECOVERY_MOVES);

/** The nodes that may be holding money nobody has accounted for. */
const unaccountedNodes = RECOVERY_NODES.filter(
  (node) => node.owesMoney !== "no",
);

describe("sumup recovery machine", () => {
  registerConformanceSweep(spec);
  registerTableChecks(spec, { events: 9, nodes: 5, shapes: 5 });

  test("a row that may hold money is never deleted on age alone", () => {
    expect(unaccountedNodes.map((node) => node.id)).toEqual([
      "waiting",
      "owed",
    ]);
    for (const node of unaccountedNodes) {
      expect(node.prunable, `${node.id} must not be prunable`).toBe(false);
      expect(RECOVERY_PRUNABLE_NODES).not.toContain(node.id);
    }
  });

  test("a row that may hold money always has something that will act on it", () => {
    for (const node of unaccountedNodes) {
      const acting = RECOVERY_EVENTS.filter(
        (event) =>
          event.actor === "system" &&
          reader.expected(node.id, event.id, "") !== "refused",
      );
      expect(acting.length, `${node.id} has no system edge`).toBeGreaterThan(0);
    }
  });

  test("a row that may hold money can still reach a closed answer", () => {
    for (const node of unaccountedNodes) {
      const closing = RECOVERY_EVENTS.filter((event) =>
        RECOVERY_TERMINAL_NODES.includes(
          reader.expected(node.id, event.id, "") as RecoveryNodeId,
        ),
      );
      expect(closing.length, `${node.id} cannot be closed`).toBeGreaterThan(0);
    }
  });

  test("the closed nodes are exactly the two that answer nothing", () => {
    expect([...RECOVERY_TERMINAL_NODES].sort()).toEqual(["finished", "unpaid"]);
  });

  test("only unanswered rows stay in the recovery queue", () => {
    expect(RECOVERY_CHECKABLE_NODES).toEqual(["waiting", "owed"]);
  });

  test("only rows with a final money answer can be pruned", () => {
    expect(RECOVERY_PRUNABLE_NODES).toEqual(["staged", "unpaid", "finished"]);
  });

  test("exactly the two settle answers stand for money moving", () => {
    expect(
      RECOVERY_EVENTS.filter((event) => event.movesMoney).map(({ id }) => id),
    ).toEqual(["read_paid_settled", "read_paid_unsettled"]);
  });

  test("the operator always hears about rows that owe money", () => {
    expect(RECOVERY_UNANSWERED_NODES).toEqual(["owed"]);
  });

  test("the operator hears about old rows whose money is unknown", () => {
    expect(RECOVERY_UNANSWERED_WHEN_OLD_NODES).toEqual(["waiting"]);
  });

  test("every node id is a word the row reader accepts", () => {
    for (const node of RECOVERY_NODES) {
      expect(parseSumupRecoveryState(node.id), node.id).toBe(node.id);
    }
  });

  test("refuses a stored word the machine does not have", () => {
    // A row carrying a word nothing here wrote means the database and this
    // code disagree, which must be raised rather than worked around.
    expect(() => parseSumupRecoveryState("abandoned")).toThrow(
      "holds unknown state abandoned",
    );
  });
});
