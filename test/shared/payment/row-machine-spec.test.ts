/** Executes the whole payment-row table through the shared machine-spec
 * executors, then proves the row-specific halves: what every successful
 * move must preserve, the terminal replace-only cell, the no-money rule,
 * the review reasons matching the retirement rule, and every exported
 * transition driving the spec. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PAYMENT_REVIEW_RETIREMENT } from "#payment/review.ts";
import {
  EXPECTED_MOVES,
  ROW_EVENTS,
  ROW_NODES,
  rowNodeOf,
} from "#payment/row-machine-spec.ts";
import type { PaymentRowState } from "#payment/row-state.ts";
import {
  registerConformanceSweep,
  registerDrivenExportsCheck,
  registerTableChecks,
} from "#test-utils/machine-spec.ts";

/** What every successful move must keep: the first found-at date on
 * unrecorded money, and the exact case the owner already saw when the
 * review's reason did not change. */
const rowInvariants = (
  source: PaymentRowState,
  result: PaymentRowState,
  cell: string,
): void => {
  if (source.unrecorded !== undefined && result.unrecorded !== undefined) {
    expect(result.unrecorded, cell).toEqual(source.unrecorded);
  }
  if (
    source.review !== undefined &&
    result.review !== undefined &&
    source.review.reason.kind === result.review.reason.kind
  ) {
    expect(result.review, cell).toEqual(source.review);
  }
};

const ROW_SPEC = {
  events: ROW_EVENTS,
  invariants: rowInvariants,
  moves: EXPECTED_MOVES,
  nodeOf: rowNodeOf,
  nodes: ROW_NODES,
};

const paymentSourceDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/shared/payment",
);

describe("the payment row table", () => {
  describe("cell conformance — every event against every stored shape", () => {
    registerConformanceSweep(ROW_SPEC);
  });

  describe("table shape", () => {
    registerTableChecks(ROW_SPEC, { events: 9, nodes: 9, shapes: 13 });
  });

  test("a row that ended admits only the outcome replace", () => {
    expect(EXPECTED_MOVES.settled).toEqual({ write_outcome: "settled" });
  });

  test("no row event moves money", () => {
    expect(ROW_EVENTS.filter(({ movesMoney }) => movesMoney)).toEqual([]);
  });

  test("every declared review reason both opens and retires", () => {
    const ids = new Set<string>(ROW_EVENTS.map(({ id }) => id));
    for (const kind of Object.keys(PAYMENT_REVIEW_RETIREMENT)) {
      expect(ids.has(`settle_open_${kind}`), kind).toBe(true);
      expect(ids.has(`settle_retire_${kind}`), kind).toBe(true);
    }
  });

  test("a mixed terminal slot is refused the way stored reads refuse it", () => {
    expect(() =>
      rowNodeOf({
        claim: ROW_NODES[1]!.reps[0]!.state.claim,
        outcome: { error: "Card declined" },
      }),
    ).toThrow("cannot share a row with live work");
  });

  registerDrivenExportsCheck(paymentSourceDir, "row-machine-spec.ts", [
    {
      file: "row-transitions.ts",
      notTransitions: {
        claimHeldBy:
          "the identity predicate — every settle cell runs it inside settledRowState",
        hasLiveRowWork:
          "the exclusivity predicate — write_outcome throws through it, and the stored-failure parser shares it",
      },
    },
  ]);
});
