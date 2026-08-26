/**
 * Whether an operation that moves or removes payment rows may go ahead. A
 * merge relocates them, a delete destroys them, and either way the rows may be
 * in the middle of something — money a run holds right now, or a decision the
 * owner has not made. Both writers ask here first.
 *
 * This module is pure: it decides from the records it is shown.
 */

import type { PaymentRowState } from "#payment/row-state.ts";

/** The attendee actions that can advance durable payment work. */
const PAYMENT_RECOVERY_ROUTES = {
  "payment-review": "/admin/attendees/:attendeeId/payment-review",
  "refresh-payment": "/admin/attendees/:attendeeId/refresh-payment",
} as const;
export type PaymentRecoveryAction = keyof typeof PAYMENT_RECOVERY_ROUTES;

/** The one operator-facing state of an attendee's payment work. */
export type PaymentWorkStatus =
  | "clear"
  | "moving"
  | "needs_money_record"
  | "needs_provider_recovery"
  | "needs_review";

/** What the operator is trying to do to the rows. */
export type RowMove = "delete" | "merge";

/** The one part of a row's record that is finished business: what it
 *  remembers about a payment that already ended, so it holds up nothing. */
type SettledField = "outcome";

/** Every other part is live work and has to say who it stops. Derived from
 *  the record, so a new kind of work is a compile error until it decides. */
type LiveWorkField = Exclude<keyof PaymentRowState, SettledField>;

type RecoveryDeclaration = {
  [Action in PaymentRecoveryAction]: {
    recoveryAction: Action;
    operatorRoute: (typeof PAYMENT_RECOVERY_ROUTES)[Action];
  };
}[PaymentRecoveryAction];

type LiveWork = RecoveryDeclaration & {
  /** The exported database operation that can remove this work. */
  clearedBy: "settleAttendeeRows";
  /** Whether this row is in the middle of this work. */
  found: (state: PaymentRowState) => boolean;
  /** The plain word for it, for the consumers that cannot decrypt. */
  mirror: string;
  /** Whether retirement must carry an explicit resolution. */
  requiresChoice: boolean;
  /** What to tell the operator, naming what to do next. */
  refusal: string;
  /** Where this comes in the order things are said when a row carries more
   *  than one, lowest first. Declared per entry because the order the fields
   *  are written in belongs to the formatter, which sorts them alphabetically
   *  — so a rename could otherwise reorder what an operator is told. */
  saidFirst: number;
  /** The one operator-facing summary of this work. */
  status: Exclude<PaymentWorkStatus, "clear">;
  /** Which operations this work stops. */
  stops: Record<RowMove, boolean>;
};

/**
 * What a payment row can be in the middle of, and who each thing stops.
 *
 * A claim stops both writers, fresh or stale. A stale one means a run died
 * holding this money, and its record is the only sign the money may be going
 * back. The other two part company: a merge RELOCATES, so the marker rides the
 * moved row and the work survives, while a delete DESTROYS the row the
 * correction needs.
 *
 * `saidFirst` orders by urgency: money moving now, then a decision only the
 * owner can make, then a record repairable mechanically.
 */
export const PAYMENT_ROW_LIFECYCLE = {
  claim: {
    clearedBy: "settleAttendeeRows",
    found: (state: PaymentRowState) => state.claim !== undefined,
    mirror: "claim",
    operatorRoute: PAYMENT_RECOVERY_ROUTES["refresh-payment"],
    recoveryAction: "refresh-payment",
    refusal:
      "A refund for this person is still in progress. Finish or re-run the refund, then try again.",
    requiresChoice: false,
    saidFirst: 0,
    status: "moving",
    stops: { delete: true, merge: true },
  },
  review: {
    clearedBy: "settleAttendeeRows",
    found: (state: PaymentRowState) => state.review !== undefined,
    mirror: "review",
    operatorRoute: PAYMENT_RECOVERY_ROUTES["payment-review"],
    recoveryAction: "payment-review",
    refusal:
      "The owner still has to resolve a payment problem for this person. Refresh or correct the payment evidence, then try again.",
    requiresChoice: true,
    saidFirst: 1,
    status: "needs_review",
    stops: { delete: true, merge: false },
  },
  unrecorded: {
    clearedBy: "settleAttendeeRows",
    found: (state: PaymentRowState) => state.unrecorded !== undefined,
    mirror: "unrecorded",
    operatorRoute: PAYMENT_RECOVERY_ROUTES["refresh-payment"],
    recoveryAction: "refresh-payment",
    refusal:
      "This person's money went back, but the accounts do not show it. Record it, then try again.",
    requiresChoice: false,
    saidFirst: 2,
    status: "needs_money_record",
    stops: { delete: true, merge: false },
  },
} as const satisfies Record<LiveWorkField, LiveWork>;

type LiveWorkEntry = (typeof PAYMENT_ROW_LIFECYCLE)[LiveWorkField];

/** The status and its action are selected together from the live-work table. */
export type PaymentWork = {
  readonly recoveryAction: PaymentRecoveryAction | null;
  readonly status: PaymentWorkStatus;
};

/** The word a row a refund run is holding shows in `protected_state`. Named
 *  here because this is where the word is decided, and read by the SQL guards
 *  that have to ask without decrypting the record. */
export const CLAIM_MIRROR: string = PAYMENT_ROW_LIFECYCLE.claim.mirror;

export type PaymentLiveWorkField = keyof typeof PAYMENT_ROW_LIFECYCLE;

/** The one SQL form of "this row carries this work", derived from the same
 *  table that decides the stored word, so a renamed mirror can never leave a
 *  query matching nothing. */
export const rowWorkMirrorSql = (
  prefix: "" | "payment.",
  field: PaymentLiveWorkField,
): string =>
  `${prefix}protected_state = '${PAYMENT_ROW_LIFECYCLE[field].mirror}'`;

/** Every kind of live work, most urgent first. Built once from the table's own
 *  `saidFirst`, so both readers below agree and neither depends on the order
 *  the fields happen to be written in. */
const WORST_FIRST: readonly LiveWorkEntry[] = Object.values(
  PAYMENT_ROW_LIFECYCLE,
).sort((one, other) => one.saidFirst - other.saidFirst);

const firstLiveWork = (
  states: readonly PaymentRowState[],
): LiveWorkEntry | undefined =>
  WORST_FIRST.find((work) => states.some(work.found));

const paymentWorkFrom = (
  hasWork: (work: LiveWorkEntry) => boolean,
  providerRefundWork: boolean,
): PaymentWork => {
  const work = WORST_FIRST.find(hasWork);
  if (providerRefundWork && work === undefined) {
    return { recoveryAction: null, status: "needs_provider_recovery" };
  }
  return work === undefined
    ? { recoveryAction: null, status: "clear" }
    : { recoveryAction: work.recoveryAction, status: work.status };
};

/** Summarize any number of rows using the same priority as every row guard. */
export const paymentWorkFor = (
  states: readonly PaymentRowState[],
  providerRefundWork = false,
): PaymentWork =>
  paymentWorkFrom((work) => states.some(work.found), providerRefundWork);

const moveRefusalWhen = (
  hasWork: (work: LiveWorkEntry) => boolean,
  move: RowMove,
): string | null => {
  const blocking = WORST_FIRST.find(
    (work) => work.stops[move] && hasWork(work),
  );
  return blocking === undefined ? null : blocking.refusal;
};

const liveWorkMirrors = (mirrors: readonly string[]): ReadonlySet<string> => {
  const known = new Set(["", ...WORST_FIRST.map((work) => work.mirror)]);
  const invalid = mirrors.find((mirror) => !known.has(mirror));
  if (invalid !== undefined) {
    throw new Error(`Unknown protected payment state: ${invalid}`);
  }
  return new Set(mirrors);
};

/** Summarize the non-sensitive mirrors with the same priority as decrypted
 * row state. Pages can use this without opening anybody's payment record. */
export const paymentWorkForMirrors = (
  mirrors: readonly string[],
  providerRefundWork: boolean,
): PaymentWork => {
  const present = liveWorkMirrors(mirrors);
  return paymentWorkFrom(
    (work) => present.has(work.mirror),
    providerRefundWork,
  );
};

/** Decide from the non-sensitive mirrors used by destructive SQL guards. */
export const mirroredMoveRefusalOrNull = (
  mirrors: readonly string[],
  move: RowMove,
): string | null => {
  const present = liveWorkMirrors(mirrors);
  return moveRefusalWhen((work) => present.has(work.mirror), move);
};

/** The plain word a row shows the consumers that cannot decrypt it — the
 *  prune and the orphan purge, both fixed-cost SQL. Every writer derives it
 *  from the record it stores, so a row whose claim is let go but whose review
 *  remains still reads as protected. Empty when nothing is live. */
export const mirrorFor = (state: PaymentRowState): string => {
  const work = firstLiveWork([state]);
  return work === undefined ? "" : work.mirror;
};
