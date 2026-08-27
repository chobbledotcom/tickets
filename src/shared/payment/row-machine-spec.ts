/** One row's slot carries up to three pieces of live work, or the terminal
 * outcome on a row that ended clean. A cell missing from
 * {@link EXPECTED_MOVES} must refuse.
 *
 * Two production truths are kept as-is rather than smoothed over. The machine
 * can retire a review the row does not hold. It can settle `books: "recorded"`
 * on a row that carries no `unrecorded` marker. Each move is a silent no-op,
 * and each STILL releases the claim. A terminal outcome can also replace an
 * earlier one, the conservative-then-final write, so `settled × write_outcome`
 * is a declared self-move, not a refusal.
 *
 * A review acknowledgement belongs to the payment-review machine. */

import { acknowledgePaymentReview } from "#payment/review.ts";
import type { PaymentRowState, RefundClaim } from "#payment/row-state.ts";
import {
  checkingClaimFor,
  grantClaim,
  hasLiveRowWork,
  type PaymentRowSettlement,
  settledRowState,
  withOutcome,
} from "#payment/row-transitions.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  type MachineEvent,
  type MachineMoves,
  type MachineMovesReader,
  type MachineNode,
  movesIn,
  machineRep as rep,
} from "#shared/schema-atlas/machine-spec.ts";

const COMMAND = "spec-row-command";
const HELD_SINCE = "2026-08-16T10:00:00.000Z";
const RETURNED_AT = "2026-08-16T11:00:00.000Z";
const SEEN_AT = "2026-08-16T12:00:00.000Z";
const HELD = { commandId: COMMAND, heldSince: HELD_SINCE };
const RELEASE: PaymentRowSettlement = { claim: "release", phase: "checking" };

const SPEC_CLAIM: RefundClaim = checkingClaimFor(
  { attendeeIds: [7], scope: "attendee_set" },
  COMMAND,
  HELD_SINCE,
);

/** The map nodes: every reachable combination of the row's fields. */
export type RowNodeId =
  | "claim"
  | "claim_review"
  | "claim_review_unrecorded"
  | "claim_unrecorded"
  | "free"
  | "review"
  | "review_unrecorded"
  | "settled"
  | "unrecorded";

/** The map node one stored row belongs to. Throws on a terminal outcome
 * sharing the slot with live work — the same law `parseSessionFailure`
 * enforces when reading a stored slot back. */
const namesByWork = (
  state: PaymentRowState,
  names: readonly [RowNodeId, RowNodeId, RowNodeId, RowNodeId],
): RowNodeId => {
  const [both, reviewOnly, unrecordedOnly, neither] = names;
  if (state.review !== undefined) {
    return state.unrecorded === undefined ? reviewOnly : both;
  }
  return state.unrecorded === undefined ? neither : unrecordedOnly;
};

export const rowNodeOf = (state: PaymentRowState): RowNodeId => {
  if (state.outcome !== undefined) {
    if (hasLiveRowWork(state)) {
      throw new Error("A terminal outcome cannot share a row with live work");
    }
    return "settled";
  }
  return state.claim === undefined
    ? namesByWork(state, ["review_unrecorded", "review", "unrecorded", "free"])
    : namesByWork(state, [
        "claim_review_unrecorded",
        "claim_review",
        "claim_unrecorded",
        "claim",
      ]);
};

/** Settle a state under the spec's own hold, or throw the given refusal. */
const settleOr =
  (refusal: string) =>
  (
    state: PaymentRowState,
    change: Omit<PaymentRowSettlement, "claim" | "phase">,
  ): PaymentRowState => {
    const out = settledRowState(
      state,
      { ...RELEASE, ...change },
      HELD,
      RETURNED_AT,
    );
    if (out === null) throw new Error(refusal);
    return out;
  };

/** Settle a fixture state; a fixture that lost its own hold is a bug in
 * the fixtures, not a machine refusal. */
const settle = settleOr("Spec fixture lost its own hold");

const held = (state: PaymentRowState): PaymentRowState =>
  grantClaim(state, SPEC_CLAIM);

/** Every review-bearing shape carries reason A; retiring reason B against
 * them exercises the wrong-reason no-op. */
const OPEN_A = {
  review: {
    kind: "review",
    reason: { kind: "partially_returned_obligation" },
  },
} as const;

const reviewOpen = settle(held({}), OPEN_A);
/** The same row after the owner saw its case — written the way the
 * acknowledge route writes it. */
const seenReview = (state: PaymentRowState): PaymentRowState => ({
  ...state,
  review: acknowledgePaymentReview(
    requireValue(state.review, "Spec fixture expected a review on the row"),
    SEEN_AT,
  ),
});
const reviewSeen = seenReview(reviewOpen);
const unrecordedOnly = settle(held({}), { books: "unrecorded" });
const reviewUnrecordedOpen = settle(held(reviewOpen), { books: "unrecorded" });
const reviewUnrecordedSeen = settle(held(reviewSeen), { books: "unrecorded" });

export type RowNode = MachineNode<PaymentRowState, RowNodeId>;

/** Every node with the real shapes behind it, each built through the
 * production transitions, so a shape can never be one the code cannot
 * reach. Review-bearing nodes carry an unseen and a seen shape. */
export const ROW_NODES: readonly RowNode[] = [
  { id: "free", reps: [rep("empty", {})] },
  { id: "claim", reps: [rep("held", held({}))] },
  {
    id: "review",
    reps: [rep("open", reviewOpen), rep("seen", reviewSeen)],
  },
  { id: "unrecorded", reps: [rep("marked", unrecordedOnly)] },
  {
    id: "claim_review",
    reps: [rep("open", held(reviewOpen)), rep("seen", held(reviewSeen))],
  },
  { id: "claim_unrecorded", reps: [rep("held", held(unrecordedOnly))] },
  {
    id: "review_unrecorded",
    reps: [
      rep("open", reviewUnrecordedOpen),
      rep("seen", reviewUnrecordedSeen),
    ],
  },
  {
    id: "claim_review_unrecorded",
    reps: [
      rep("open", held(reviewUnrecordedOpen)),
      rep("seen", held(reviewUnrecordedSeen)),
    ],
  },
  {
    id: "settled",
    reps: [rep("ended", withOutcome({}, { error: "Card declined" }))],
  },
];

export type RowEventId =
  | "claim_granted"
  | "settle_found_unrecorded"
  | "settle_open_partially_returned_obligation"
  | "settle_open_shared_reference"
  | "settle_recorded"
  | "settle_release"
  | "settle_retire_partially_returned_obligation"
  | "settle_retire_shared_reference"
  | "write_outcome";

export type RowMachineEvent = MachineEvent<PaymentRowState, RowEventId>;

const settleEvent = (
  id: RowEventId,
  change: Omit<PaymentRowSettlement, "claim" | "phase">,
): RowMachineEvent => ({
  actor: "system",
  id,
  labelKey: `schema.row.edge.${id}`,
  movesMoney: false,
  run: (state) =>
    settleOr("This settlement does not hold the row")(state, change),
});

/** Every way one row's record can move, each running the real transition.
 * No row event sends money — sends belong to the refund machine. */
export const ROW_EVENTS: readonly RowMachineEvent[] = [
  {
    actor: "system",
    id: "claim_granted",
    labelKey: "schema.row.edge.claim_granted",
    movesMoney: false,
    run: (state) => {
      if (state.outcome !== undefined) {
        throw new Error("A settled row takes no new work");
      }
      if (state.claim !== undefined) {
        throw new Error("A row already holding a claim refuses a fresh hold");
      }
      return grantClaim(state, SPEC_CLAIM);
    },
  },
  settleEvent("settle_release", {}),
  settleEvent("settle_recorded", { books: "recorded" }),
  settleEvent("settle_found_unrecorded", { books: "unrecorded" }),
  settleEvent("settle_open_partially_returned_obligation", OPEN_A),
  settleEvent("settle_open_shared_reference", {
    review: { kind: "review", reason: { kind: "shared_reference" } },
  }),
  settleEvent("settle_retire_partially_returned_obligation", {
    review: { kind: "resolved", reason: "partially_returned_obligation" },
  }),
  settleEvent("settle_retire_shared_reference", {
    review: { kind: "resolved", reason: "shared_reference" },
  }),
  {
    actor: "system",
    id: "write_outcome",
    labelKey: "schema.row.edge.write_outcome",
    movesMoney: false,
    run: (state) => withOutcome(state, { error: "Card declined" }),
  },
];

/** The declared machine: for each node, the events that must move it and
 * where to. Every other (event × shape) pair must refuse — settlements
 * refuse rows they do not hold, a held or settled row refuses a fresh
 * hold, and a terminal outcome refuses live work. */
export const EXPECTED_MOVES: MachineMoves<RowNodeId, RowEventId> = {
  claim: {
    settle_found_unrecorded: "unrecorded",
    settle_open_partially_returned_obligation: "review",
    settle_open_shared_reference: "review",
    settle_recorded: "free",
    settle_release: "free",
    settle_retire_partially_returned_obligation: "free",
    settle_retire_shared_reference: "free",
  },
  claim_review: {
    settle_found_unrecorded: "review_unrecorded",
    settle_open_partially_returned_obligation: "review",
    settle_open_shared_reference: "review",
    settle_recorded: "review",
    settle_release: "review",
    settle_retire_partially_returned_obligation: "free",
    settle_retire_shared_reference: "review",
  },
  claim_review_unrecorded: {
    settle_found_unrecorded: "review_unrecorded",
    settle_open_partially_returned_obligation: "review_unrecorded",
    settle_open_shared_reference: "review_unrecorded",
    settle_recorded: "review",
    settle_release: "review_unrecorded",
    settle_retire_partially_returned_obligation: "unrecorded",
    settle_retire_shared_reference: "review_unrecorded",
  },
  claim_unrecorded: {
    settle_found_unrecorded: "unrecorded",
    settle_open_partially_returned_obligation: "review_unrecorded",
    settle_open_shared_reference: "review_unrecorded",
    settle_recorded: "free",
    settle_release: "unrecorded",
    settle_retire_partially_returned_obligation: "unrecorded",
    settle_retire_shared_reference: "unrecorded",
  },
  free: {
    claim_granted: "claim",
    write_outcome: "settled",
  },
  review: {
    claim_granted: "claim_review",
  },
  review_unrecorded: {
    claim_granted: "claim_review_unrecorded",
  },
  // The conservative-then-final outcome write may replace itself; nothing
  // else moves a row that ended.
  settled: {
    write_outcome: "settled",
  },
  unrecorded: {
    claim_granted: "claim_unrecorded",
  },
};

export const ROW_MOVES: MachineMovesReader<RowNodeId, RowEventId> =
  movesIn(EXPECTED_MOVES);
