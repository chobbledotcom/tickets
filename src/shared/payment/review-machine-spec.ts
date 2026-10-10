/** The payment-review machine as one executable table.
 *
 * A review slot is the review side of one payment row: no case held, an
 * open case, or a case the owner saw. The transitions are the real
 * review functions plus the one declared retirement rule per reason. The
 * mirror test executes every (node × event × shape) cell against them and
 * holds the declared moves table: a cell it does not name must refuse. */

import {
  acknowledgePaymentReview,
  openPaymentReview,
  PAYMENT_REVIEW_RETIREMENT,
  type PaymentReviewCase,
  type PaymentReviewReason,
} from "#payment/review.ts";
import {
  type MachineEvent,
  type MachineNode,
  machineRep as rep,
} from "#shared/schema-atlas/machine-spec.ts";

/** The review slot of one payment row: undefined means no review is held. */
export type ReviewSlot = PaymentReviewCase | undefined;

const SEEN_AT = "2026-08-16T00:00:00.000Z";

/** Every reason a review can hold, in table order. The mirror test pins
 * this against the retirement rule's own keys, so a new reason is red here
 * until its rows join the table. */
export const REVIEW_REASONS = [
  "partially_returned_obligation",
  "shared_reference",
] as const satisfies readonly PaymentReviewReason["kind"][];

export type ReviewNodeId = "none" | "open" | "seen";

/** The map node one review slot belongs to. Total: every slot has exactly
 * one home. */
export const reviewNodeOf = (slot: ReviewSlot): ReviewNodeId =>
  slot === undefined
    ? "none"
    : slot.acknowledgedAt === undefined
      ? "open"
      : "seen";

const openCase = (kind: PaymentReviewReason["kind"]): PaymentReviewCase =>
  openPaymentReview({ kind });

export type ReviewNode = MachineNode<ReviewSlot, ReviewNodeId>;

/** Every node with the real slots behind it: one per declared reason for
 * the held states, and the one empty slot. */
export const REVIEW_NODES: readonly ReviewNode[] = [
  { id: "none", reps: [rep("empty", undefined)] },
  { id: "open", reps: REVIEW_REASONS.map((kind) => rep(kind, openCase(kind))) },
  {
    id: "seen",
    reps: REVIEW_REASONS.map((kind) =>
      rep(kind, acknowledgePaymentReview(openCase(kind), SEEN_AT)),
    ),
  },
];

export type ReviewEventId =
  | "acknowledge"
  | "open_partially_returned_obligation"
  | "open_shared_reference"
  | "retire_partially_returned_obligation"
  | "retire_shared_reference";

export type ReviewMachineEvent = MachineEvent<ReviewSlot, ReviewEventId>;

/** A case opens only on a row that holds none. The engine refuses a
 * same-reason reopen, and this guard keeps that refusal in the map. */
const opensFor =
  (reason: PaymentReviewReason) =>
  (slot: ReviewSlot): ReviewSlot => {
    if (slot !== undefined) {
      throw new Error("A row with a review cannot open another");
    }
    return openPaymentReview(reason);
  };

/** The one declared way each reason retires. */
const retiresFor =
  (kind: PaymentReviewReason["kind"]) =>
  (slot: ReviewSlot): ReviewSlot => {
    if (slot === undefined || slot.reason.kind !== kind) {
      throw new Error(`This evidence retires only a ${kind} review`);
    }
    return;
  };

/** Every way a review slot can move, each running the real function. */
export const REVIEW_EVENTS: readonly ReviewMachineEvent[] = [
  {
    actor: "system",
    id: "open_partially_returned_obligation",
    labelKey: "schema.review.reason.partially_returned_obligation",
    movesMoney: false,
    run: opensFor({ kind: "partially_returned_obligation" }),
  },
  {
    actor: "system",
    id: "open_shared_reference",
    labelKey: "schema.review.reason.shared_reference",
    movesMoney: false,
    run: opensFor({ kind: "shared_reference" }),
  },
  {
    actor: "owner",
    id: "acknowledge",
    labelKey: "schema.review.edge.acknowledge",
    movesMoney: false,
    run: (slot: ReviewSlot): ReviewSlot => {
      if (slot === undefined || slot.acknowledgedAt !== undefined) {
        throw new Error("Only an unseen case can be acknowledged");
      }
      return acknowledgePaymentReview(slot, SEEN_AT);
    },
  },
  {
    actor: "system",
    id: "retire_partially_returned_obligation",
    labelKey: `schema.review.evidence.${PAYMENT_REVIEW_RETIREMENT.partially_returned_obligation}`,
    movesMoney: false,
    run: retiresFor("partially_returned_obligation"),
  },
  {
    actor: "system",
    id: "retire_shared_reference",
    labelKey: `schema.review.evidence.${PAYMENT_REVIEW_RETIREMENT.shared_reference}`,
    movesMoney: false,
    run: retiresFor("shared_reference"),
  },
];
