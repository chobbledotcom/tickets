/** Executes the whole refund machine table through the shared machine-spec
 * executors, then proves the refund-specific halves: every stored state
 * kind is represented, owner exits match the choices module, money events
 * are exactly the sends, the UI derivations read true, and every exported
 * transition drives the spec. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundOwnerChoices } from "#payment/refund-authority-choice.ts";
import type { RefundAuthorityState } from "#payment/refund-authority-state.ts";
import {
  EXPECTED_MOVES,
  REFUND_EVENTS,
  REFUND_MOVES,
  REFUND_NODES,
  refundChoiceTarget,
  refundNodeOf,
  refundNodeSendsMoney,
} from "#payment/refund-machine-spec.ts";
import {
  registerConformanceSweep,
  registerDrivenExportsCheck,
  registerTableChecks,
} from "#test-utils/machine-spec.ts";

const REFUND_SPEC = {
  events: REFUND_EVENTS,
  // The machine-wide laws: a request never changes provider capability,
  // and evidence and generation counters only ever move forward.
  invariants: (
    source: RefundAuthorityState,
    result: RefundAuthorityState,
    cell: string,
  ): void => {
    expect(result.request.capability, cell).toBe(source.request.capability);
    expect(result.evidenceRevision, cell).toBeGreaterThanOrEqual(
      source.evidenceRevision,
    );
    expect(result.request.generation, cell).toBeGreaterThanOrEqual(
      source.request.generation,
    );
  },
  moves: EXPECTED_MOVES,
  nodeOf: refundNodeOf,
  nodes: REFUND_NODES,
};

const paymentSourceDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/shared/payment",
);

describe("the refund machine table", () => {
  describe("cell conformance — every event against every stored shape", () => {
    registerConformanceSweep(REFUND_SPEC);
  });

  describe("table shape", () => {
    registerTableChecks(REFUND_SPEC, { events: 15, nodes: 9, shapes: 28 });
  });

  test("the representatives cover every stored state kind", () => {
    const kinds = new Set(
      REFUND_NODES.flatMap(({ reps }) => reps.map(({ state }) => state.kind)),
    );
    expect([...kinds].sort()).toEqual([
      "completed",
      "needs_owner_choice",
      "needs_provider_check",
      "observing",
      "ready",
      "send_armed",
    ]);
  });

  test("recorded is terminal: the table declares no move out of it", () => {
    expect(EXPECTED_MOVES.recorded).toEqual({});
  });

  test("only the two sends move money", () => {
    expect(
      REFUND_EVENTS.filter(({ movesMoney }) => movesMoney).map(({ id }) => id),
    ).toEqual(["arm", "replay"]);
  });

  test("the table's owner exits are exactly the choices the code admits", () => {
    let checkedShapes = 0;
    for (const node of REFUND_NODES) {
      for (const { state, tag } of node.reps) {
        if (state.kind !== "needs_owner_choice") continue;
        checkedShapes++;
        // Each choice resolves to its own node, so comparing target sets
        // matches choices to declared exits exactly, in both directions.
        // record_in_money is the owner's bookkeeping action, not a decision
        // answer, so it stays outside the comparison.
        const admitted = refundOwnerChoices(state).map(refundChoiceTarget);
        const declared = REFUND_EVENTS.filter(
          (event) => event.actor === "owner" && event.id !== "record_in_money",
        )
          .map((event) => REFUND_MOVES.expected(node.id, event.id, tag))
          .filter((target) => target !== "refused");
        expect([...declared].sort(), `${node.id} [${tag}]`).toEqual(
          [...admitted].sort(),
        );
      }
    }
    // choice_open's four shapes plus three each behind the two settled
    // conflict decisions.
    expect(checkedShapes).toBe(10);
  });

  test("owner choices resolve to the nodes the table declares", () => {
    expect(refundChoiceTarget("provider_confirmed_not_sent")).toBe("ready");
    expect(refundChoiceTarget("provider_confirmed_returned")).toBe("returned");
  });

  test("money-capable nodes are exactly the send launchpads", () => {
    expect(
      REFUND_NODES.filter(({ id }) => refundNodeSendsMoney(id)).map(
        ({ id }) => id,
      ),
    ).toEqual(["ready", "send_armed", "observing"]);
  });

  registerDrivenExportsCheck(paymentSourceDir, "refund-machine-spec.ts", [
    {
      file: "refund-authority.ts",
      notTransitions: {
        requireActiveSentRefund:
          "a guard inside transitions — every armed-only refusal in the sweep exercises it",
      },
    },
    {
      file: "refund-authority-choice.ts",
      notTransitions: {
        refundOwnerChoices:
          "a query — executed by the owner-exit derivation test above",
      },
    },
  ]);
});
