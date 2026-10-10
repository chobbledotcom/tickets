/** Executes the whole payment-review table through the shared machine-spec
 * executors, then proves the review-specific halves: the reason list
 * matches the retirement rule, every reason both opens and retires, no
 * review event moves money, and every exported review function drives the
 * spec. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PAYMENT_REVIEW_RETIREMENT } from "#payment/review.ts";
import {
  REVIEW_EVENTS,
  REVIEW_NODES,
  REVIEW_REASONS,
  type ReviewEventId,
  type ReviewNodeId,
  type ReviewSlot,
  reviewNodeOf,
} from "#payment/review-machine-spec.ts";
import type { MachineMoves } from "#shared/schema-atlas/machine-spec.ts";
import {
  registerConformanceSweep,
  registerDrivenExportsCheck,
  registerTableChecks,
} from "#test-utils/machine-spec.ts";

/** A held case retires the same way whether or not it was seen: only its
 * own reason's evidence sends it back to the empty slot. */
const RETIRE_MOVES = {
  retire_partially_returned_obligation: {
    perRep: { partially_returned_obligation: "none" },
  },
  retire_shared_reference: { perRep: { shared_reference: "none" } },
} as const;

/** The declared machine: for each node, the events that must move it and
 * where to. Every other (event × shape) pair must refuse. A held case
 * blocks a second open, only its own evidence retires it, and only an
 * unseen case can be acknowledged. */
const EXPECTED_MOVES: MachineMoves<ReviewNodeId, ReviewEventId> = {
  none: {
    open_partially_returned_obligation: "open",
    open_shared_reference: "open",
  },
  open: { acknowledge: "seen", ...RETIRE_MOVES },
  seen: RETIRE_MOVES,
};

const REVIEW_SPEC = {
  events: REVIEW_EVENTS,
  // The machine-wide law: a move that keeps a case held (acknowledging)
  // keeps that exact case — same id, same reason — so an old form can
  // never end up pointing at a different disagreement.
  invariants: (source: ReviewSlot, result: ReviewSlot, cell: string): void => {
    if (source === undefined || result === undefined) return;
    expect(result.caseId, cell).toBe(source.caseId);
    expect(result.reason.kind, cell).toBe(source.reason.kind);
  },
  moves: EXPECTED_MOVES,
  nodeOf: reviewNodeOf,
  nodes: REVIEW_NODES,
};

const paymentSourceDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/shared/payment",
);

describe("the payment review table", () => {
  describe("cell conformance — every event against every stored shape", () => {
    registerConformanceSweep(REVIEW_SPEC);
  });

  describe("table shape", () => {
    registerTableChecks(REVIEW_SPEC, { events: 5, nodes: 3, shapes: 5 });
  });

  test("the reason list is exactly the retirement rule's own keys", () => {
    expect([...REVIEW_REASONS].sort()).toEqual(
      Object.keys(PAYMENT_REVIEW_RETIREMENT).sort(),
    );
  });

  test("every reason both opens and retires, labelled by its own rule", () => {
    const byId = new Map(REVIEW_EVENTS.map((event) => [event.id, event]));
    expect(byId.get("acknowledge")?.labelKey).toBe(
      "schema.review.edge.acknowledge",
    );
    for (const kind of REVIEW_REASONS) {
      const opens = byId.get(`open_${kind}`);
      const retires = byId.get(`retire_${kind}`);
      expect(opens?.labelKey, kind).toBe(`schema.review.reason.${kind}`);
      expect(retires?.labelKey, kind).toBe(
        `schema.review.evidence.${PAYMENT_REVIEW_RETIREMENT[kind]}`,
      );
    }
  });

  test("no review event moves money", () => {
    expect(REVIEW_EVENTS.filter(({ movesMoney }) => movesMoney)).toEqual([]);
  });

  registerDrivenExportsCheck(paymentSourceDir, "review-machine-spec.ts", [
    {
      file: "review.ts",
      notTransitions: {
        PaymentReviewCaseSchema:
          "the stored shape — validated where cases are read and written",
        PaymentReviewReasonSchema:
          "the reason shape — validated where cases are read and written",
      },
    },
  ]);
});
