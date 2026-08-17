/**
 * The legal combinations of one payment row's machines. A row's stored state
 * (the row machine), its charges' refund authority (the refund machine), and
 * its delivery phase are three tables checked one at a time — this module is
 * the seam between them: which combinations may exist in one database at one
 * moment.
 *
 * The declaration is an ILLEGAL list, each entry naming the invariant it
 * breaks. A combination is only listed when no flow can produce it — every
 * crash window's intermediate state is a legal combination by design, because
 * a redelivery must be able to finish from it. Anything not listed is legal,
 * so a new flow never trips this seam by surprise; the witness checks in the
 * crash tests are what tighten the list over time.
 *
 * This module is pure. The phase collapses into the row fact: any stored row
 * state means `failure_data` is set, so only a free row splits by phase
 * (reserved in flight, finalized booked).
 */

import { type ROW_NODES, rowNodeOf } from "#shared/payment/row-machine-spec.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";

/** One charge's refund authority as this seam sees it: the stored state
 * name (whether its local recording is done is a separate column and a
 * separate concern), or "absent" when the row's references have no charge
 * at all. */
export type AuthorityFact =
  | "absent"
  | "ready"
  | "send_armed"
  | "observing"
  | "completed"
  | "needs_owner_choice"
  | "needs_provider_check";

const AUTHORITY_NAMES: readonly AuthorityFact[] = [
  "ready",
  "send_armed",
  "observing",
  "completed",
  "needs_owner_choice",
  "needs_provider_check",
];

/** The authority fact for one stored state name — null means the reference
 * carries no charge. An unknown name throws: it would mean the authority
 * machine grew a state this seam has never heard of. */
export const authorityFactOf = (name: string | null): AuthorityFact => {
  if (name === null) return "absent";
  const known = AUTHORITY_NAMES.find((candidate) => candidate === name);
  if (known === undefined) {
    throw new Error(`Unknown refund authority state name: ${name}`);
  }
  return known;
};

/** One row as this seam sees it: its machine node, with the free node split
 * by delivery phase — the only split the phase adds. */
export type JointRowFact =
  | "free_reserved"
  | "free_finalized"
  | Exclude<(typeof ROW_NODES)[number]["id"], "free">;

/** Why a combination can never exist. Each reason is one invariant a flow
 * relies on; the entry makes it checkable instead of implicit. */
export interface IllegalJointState {
  readonly authority: AuthorityFact;
  readonly reason: string;
  readonly rows: readonly JointRowFact[];
}

const NO_CLAIM_ROWS: readonly JointRowFact[] = [
  "free_reserved",
  "free_finalized",
  "review",
  "unrecorded",
  "review_unrecorded",
  "settled",
];

const CLAIM_ROWS: readonly JointRowFact[] = [
  "claim",
  "claim_review",
  "claim_unrecorded",
  "claim_review_unrecorded",
];

/**
 * The declared impossible combinations. Kept short on purpose: every entry
 * must be provable from the flows, because the verifier reports each match
 * to an operator as data needing repair.
 */
export const ILLEGAL_JOINT_STATES: readonly IllegalJointState[] = [
  {
    authority: "send_armed",
    reason:
      "A provider send is armed only under a held claim, and the claim is " +
      "released only after the send completes — an armed charge on a row " +
      "nobody holds has no flow that finishes it.",
    rows: NO_CLAIM_ROWS,
  },
  {
    authority: "absent",
    reason:
      "A claim is admitted only over references that carry a charge, so a " +
      "held row whose references have no charge cannot have been claimed.",
    rows: CLAIM_ROWS,
  },
];

/** The row fact for one parsed row state, split by phase when free.
 * `finalized` is the phase axis: true once the session booked (attendee
 * set), false while the reservation is in flight. A stored row carries its
 * pending outcome beside its live work through the whole crash window, so
 * the fact comes from the live work alone — only a row holding nothing but
 * an outcome is settled. */
export const jointRowFactOf = (
  state: PaymentRowState,
  finalized: boolean,
): JointRowFact => {
  const hasLiveWork =
    state.claim !== undefined ||
    state.review !== undefined ||
    state.unrecorded !== undefined;
  const node = rowNodeOf(
    hasLiveWork
      ? {
          ...(state.claim === undefined ? {} : { claim: state.claim }),
          ...(state.review === undefined ? {} : { review: state.review }),
          ...(state.unrecorded === undefined
            ? {}
            : { unrecorded: state.unrecorded }),
        }
      : state,
  );
  if (node !== "free") return node;
  return finalized ? "free_finalized" : "free_reserved";
};

/** The declared reason `row × authority` cannot exist, or null when the
 * combination is legal. */
export const illegalJointReasonOrNull = (
  row: JointRowFact,
  authority: AuthorityFact,
): string | null => {
  for (const entry of ILLEGAL_JOINT_STATES) {
    if (entry.authority === authority && entry.rows.includes(row)) {
      return entry.reason;
    }
  }
  return null;
};

/**
 * Throw when a row and any of its charges' authorities form a declared
 * impossible combination. Callers pass every authority fact the row's
 * references carry ("absent" when they carry none), with `context` naming
 * the flow for the error.
 */
export const assertJointStateLegal = (
  row: JointRowFact,
  authorities: Iterable<AuthorityFact>,
  context: string,
): void => {
  for (const authority of authorities) {
    const reason = illegalJointReasonOrNull(row, authority);
    if (reason !== null) {
      throw new Error(
        `${context}: row ${row} cannot carry a ${authority} charge — ${reason}`,
      );
    }
  }
};
