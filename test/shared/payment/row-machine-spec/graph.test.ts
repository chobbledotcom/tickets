/** Whole-machine properties computed over the declared row table: every
 * node reachable, every live node able to come free, the one clearer
 * really dropping each kind of work, the terminal outcome sealed off from
 * live work, and the lifecycle's words — mirror, status, refusals —
 * proven for every stored shape rather than a hand-picked few. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  mirroredMoveRefusalOrNull,
  mirrorFor,
  PAYMENT_ROW_LIFECYCLE,
  type PaymentWork,
  paymentWorkFor,
  paymentWorkForMirrors,
} from "#shared/payment/admit-move.ts";
import {
  ROW_EVENTS,
  ROW_MOVES,
  ROW_NODES,
  type RowEventId,
  type RowNode,
  type RowNodeId,
} from "#shared/payment/row-machine-spec.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";
import { machineGraph } from "#test-utils/machine-graph.ts";

const graph = machineGraph({
  events: ROW_EVENTS,
  label: "row",
  nodes: ROW_NODES,
  targets: (from: RowNodeId, event: RowEventId) =>
    ROW_MOVES.targets(from, event),
});

const LIVE_NODES = ROW_NODES.filter(
  ({ id }) => id !== "free" && id !== "settled",
);

/** The lifecycle's words for each node, asserted for every shape below.
 * Refusal sentences come from the table itself, so the words the operator
 * reads are the words the machine proves. */
const NODE_FACTS: Readonly<
  Record<
    RowNodeId,
    {
      readonly mirror: string;
      readonly refusals: {
        readonly delete: string | null;
        readonly merge: string | null;
      };
      readonly work: PaymentWork;
    }
  >
> = {
  claim: {
    mirror: "claim",
    refusals: {
      delete: PAYMENT_ROW_LIFECYCLE.claim.refusal,
      merge: PAYMENT_ROW_LIFECYCLE.claim.refusal,
    },
    work: { recoveryAction: "refresh-payment", status: "moving" },
  },
  claim_review: {
    mirror: "claim",
    refusals: {
      delete: PAYMENT_ROW_LIFECYCLE.claim.refusal,
      merge: PAYMENT_ROW_LIFECYCLE.claim.refusal,
    },
    work: { recoveryAction: "refresh-payment", status: "moving" },
  },
  claim_review_unrecorded: {
    mirror: "claim",
    refusals: {
      delete: PAYMENT_ROW_LIFECYCLE.claim.refusal,
      merge: PAYMENT_ROW_LIFECYCLE.claim.refusal,
    },
    work: { recoveryAction: "refresh-payment", status: "moving" },
  },
  claim_unrecorded: {
    mirror: "claim",
    refusals: {
      delete: PAYMENT_ROW_LIFECYCLE.claim.refusal,
      merge: PAYMENT_ROW_LIFECYCLE.claim.refusal,
    },
    work: { recoveryAction: "refresh-payment", status: "moving" },
  },
  free: {
    mirror: "",
    refusals: { delete: null, merge: null },
    work: { recoveryAction: null, status: "clear" },
  },
  review: {
    mirror: "review",
    refusals: {
      delete: PAYMENT_ROW_LIFECYCLE.review.refusal,
      merge: null,
    },
    work: { recoveryAction: "payment-review", status: "needs_review" },
  },
  review_unrecorded: {
    mirror: "review",
    refusals: {
      delete: PAYMENT_ROW_LIFECYCLE.review.refusal,
      merge: null,
    },
    work: { recoveryAction: "payment-review", status: "needs_review" },
  },
  settled: {
    mirror: "",
    refusals: { delete: null, merge: null },
    work: { recoveryAction: null, status: "clear" },
  },
  unrecorded: {
    mirror: "unrecorded",
    refusals: {
      delete: PAYMENT_ROW_LIFECYCLE.unrecorded.refusal,
      merge: null,
    },
    work: { recoveryAction: "refresh-payment", status: "needs_money_record" },
  },
};

/** Whether some settlement out of a held node lands where this work is
 * gone from every shape. */
const settleDrops = (
  node: RowNode,
  found: (state: PaymentRowState) => boolean,
): boolean =>
  ROW_EVENTS.some(
    (event) =>
      event.id.startsWith("settle_") &&
      node.reps.some(({ tag }) => {
        const target = ROW_MOVES.expected(node.id, event.id, tag);
        if (target === "refused") return false;
        return graph.nodeById(target).reps.every(({ state }) => !found(state));
      }),
  );

/** A held node must have a settlement that lands where this work is gone;
 * a claimless one must take the hold with the work still in place — the
 * settle then drops it (proved by the held case and the liveness walk). */
const expectClearerReaches = (
  field: string,
  found: (state: PaymentRowState) => boolean,
  node: RowNode,
): void => {
  if (node.id.startsWith("claim")) {
    expect(
      settleDrops(node, found),
      `${field} never drops from ${node.id}`,
    ).toBe(true);
    return;
  }
  const target = ROW_MOVES.plain(node.id, "claim_granted");
  expect(
    graph.nodeById(target).reps.some(({ state }) => found(state)),
    `${field} is lost taking the hold on ${node.id}`,
  ).toBe(true);
};

/** Every (node × event × shape) cell whose declared target is `settled`. */
const cellsLandingOnSettled = (): readonly string[] =>
  ROW_NODES.flatMap((node) =>
    ROW_EVENTS.flatMap((event) =>
      node.reps.flatMap(({ tag }) =>
        ROW_MOVES.expected(node.id, event.id, tag) === "settled"
          ? [`${node.id} × ${event.id}`]
          : [],
      ),
    ),
  );

describe("the payment row graph", () => {
  test("every node is reachable from free", () => {
    expect([...graph.reachableFrom("free")].sort()).toEqual(
      ROW_NODES.map(({ id }) => id).sort(),
    );
  });

  test("every live node can come free", () => {
    for (const node of LIVE_NODES) {
      expect(
        graph.reachableFrom(node.id).has("free"),
        `${node.id} cannot end`,
      ).toBe(true);
    }
  });

  test("every shape of a live node has its own way out", () => {
    for (const node of LIVE_NODES) {
      for (const { tag } of node.reps) {
        const hasExit = ROW_EVENTS.some(
          (event) => ROW_MOVES.expected(node.id, event.id, tag) !== "refused",
        );
        expect(hasExit, `${node.id} [${tag}] is stranded`).toBe(true);
      }
    }
  });

  test("the one clearer drops each kind of work from every node holding it", () => {
    for (const [field, entry] of Object.entries(PAYMENT_ROW_LIFECYCLE)) {
      expect(entry.clearedBy, field).toBe("settleAttendeeRows");
      for (const node of ROW_NODES) {
        if (!node.reps.some(({ state }) => entry.found(state))) continue;
        expectClearerReaches(field, entry.found, node);
      }
    }
  });

  test("a terminal outcome is sealed off from live work", () => {
    for (const node of LIVE_NODES) {
      for (const { tag } of node.reps) {
        expect(
          ROW_MOVES.expected(node.id, "write_outcome", tag),
          `${node.id} [${tag}] must refuse a terminal outcome`,
        ).toBe("refused");
      }
    }
    expect(cellsLandingOnSettled()).toEqual([
      "free × write_outcome",
      "settled × write_outcome",
    ]);
  });

  test("the lifecycle's words hold for every stored shape", () => {
    for (const node of ROW_NODES) {
      const facts = NODE_FACTS[node.id];
      for (const { state, tag } of node.reps) {
        const cell = `${node.id} [${tag}]`;
        expect(mirrorFor(state), cell).toBe(facts.mirror);
        expect(paymentWorkFor([state]), cell).toEqual(facts.work);
        for (const move of ["delete", "merge"] as const) {
          expect(
            mirroredMoveRefusalOrNull([mirrorFor(state)], move),
            `${cell} ${move}`,
          ).toBe(facts.refusals[move]);
        }
      }
    }
  });

  test("the words and the stored record always agree", () => {
    for (const node of ROW_NODES) {
      for (const { state, tag } of node.reps) {
        for (const providerWork of [false, true]) {
          expect(
            paymentWorkFor([state], providerWork),
            `${node.id} [${tag}] provider=${providerWork}`,
          ).toEqual(paymentWorkForMirrors([mirrorFor(state)], providerWork));
        }
      }
    }
  });
});
