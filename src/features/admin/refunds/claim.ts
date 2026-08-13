import { compact, requiredMapValue } from "#fp";
import {
  claimAttendeeRows,
  type ClaimResult,
  type InheritedArmedRefunds,
  type LoadedRefundAttendee,
  paymentReferenceRepresentations,
  type RefundClaimAdmission,
} from "#shared/db/payment-claim/take.ts";
import {
  type PaymentReviewChange,
  type PaymentRowSettlement,
  type RowSettlement,
  settleAttendeeRows,
} from "#shared/db/payment-claim.ts";
import {
  claimRefusal,
  heldPaymentRows,
  mayReleaseClaim,
} from "#shared/payment/claim.ts";
import type { PaymentReviewReason } from "#shared/payment/review.ts";
import type { RefundClaimPhase } from "#shared/payment/row-state.ts";
import { requireValue } from "#shared/required-value.ts";
import { withSubrequestReserve } from "#shared/subrequest-budget.ts";
import { REFUND_SETTLEMENT_SUBREQUEST_RESERVE } from "./budget.ts";
import { reportRefundProblem } from "./report.ts";

/** Taking and letting go of the hold on an attendee's payment rows. Injected
 *  so the tally and ordering rules can be tested without a database. */
export type RowClaim = {
  claim: (
    attendees: readonly LoadedRefundAttendee[],
    admit?: RefundClaimAdmission,
  ) => Promise<ClaimResult>;
  settle: (settlement: RowSettlement) => Promise<void>;
};

/** What a run could not prove about one attendee's money. */
export type AttendeeDoubt = "in_doubt" | "unread";

/** What a run learnt about the attendees it held. */
export type RunFindings = {
  /** Exact durable phase each claimed row reached in this command. */
  claimPhases: Map<string, RefundClaimPhase>;
  /** Attendees whose money this run could not account for. */
  doubts: Map<number, AttendeeDoubt>;
  /** Rows whose returned money the books have not caught up with. */
  unrecorded: Map<number, readonly string[]>;
  /** Review decisions to apply as these exact rows are released. */
  reviews: Map<string, PaymentReviewChange>;
  /** Rows whose returned money this run did record in the books. */
  recorded: Set<string>;
};

/** Why a run could not take the complete set it loaded. */
export type RefundRunBlock =
  | { kind: "claim_held"; reason: string }
  | { kind: "payment_set_changed"; reason: string };

/** The exact durable hold provider preparation must bind before any send. */
export type HeldRefundClaim = Pick<
  Extract<ClaimResult, { kind: "claimed" }>,
  "commandId" | "held" | "heldSince" | "phases"
>;

/** The facts protected by one complete attendee-row claim. */
export interface HeldRefundWork {
  readonly alreadyReturned: ReadonlySet<string>;
  readonly claim: HeldRefundClaim;
  readonly findings: RunFindings;
  readonly inherited: InheritedArmedRefunds;
  readonly reviews: ReadonlyMap<string, PaymentReviewReason>;
  readonly shared: Extract<ClaimResult, { kind: "claimed" }>["shared"];
  readonly unrecorded: ReadonlyMap<number, readonly string[]>;
}

export const durableRowClaim: RowClaim = {
  claim: claimAttendeeRows,
  settle: settleAttendeeRows,
};

/** Whether this attendee's rows may be let go. */
const mayLetGo = (
  doubt: AttendeeDoubt | undefined,
  resumed: boolean,
): boolean => {
  if (doubt === "in_doubt") return mayReleaseClaim("lost");
  // Learning nothing settles nothing, so an inherited hold keeps whatever the
  // dead run left on it.
  if (doubt === "unread") {
    return mayReleaseClaim(resumed ? "lost" : "not_sent");
  }
  return mayReleaseClaim("validated");
};

/** Settle held rows, reporting rather than raising when a row will not. */
const settleHold = async (
  rowClaim: RowClaim,
  settlement: RowSettlement,
  listingId: number,
): Promise<void> => {
  if (settlement.rows.size === 0) return;
  try {
    await rowClaim.settle(settlement);
  } catch (error) {
    reportRefundProblem({ error, kind: "claim_settlement" }, listingId);
  }
};

const booksChange = (
  findings: RunFindings,
  unrecorded: ReadonlySet<string>,
  sessionId: string,
): PaymentRowSettlement["books"] => {
  const missed = unrecorded.has(sessionId);
  const recorded = findings.recorded.has(sessionId);
  if (missed && recorded) {
    throw new Error("Refund row had contradictory recording results");
  }
  return missed ? "unrecorded" : recorded ? "recorded" : undefined;
};

type SettlementEntry = readonly [string, PaymentRowSettlement];

const settlementEntry = (
  attendeeId: number,
  sessionId: string,
  lettingAttendees: ReadonlySet<number>,
  unrecorded: ReadonlySet<string>,
  findings: RunFindings,
  phases: ReadonlyMap<string, RefundClaimPhase>,
): SettlementEntry | null => {
  const books = booksChange(findings, unrecorded, sessionId);
  const review = findings.reviews.get(sessionId);
  const claim = lettingAttendees.has(attendeeId) ? "release" : "keep";
  if (claim === "keep" && books === undefined && review === undefined) {
    return null;
  }
  return [
    sessionId,
    {
      ...(books === undefined ? {} : { books }),
      claim,
      phase: requiredMapValue(
        phases,
        sessionId,
        "Refund settlement lost a payment-row phase",
      ),
      ...(review === undefined ? {} : { review }),
    },
  ];
};

const settlementRows = (
  claim: Extract<ClaimResult, { kind: "claimed" }>,
  findings: RunFindings,
): ReadonlyMap<string, PaymentRowSettlement> => {
  const lettingAttendees = new Set(
    [...claim.held]
      .filter(([attendeeId]) =>
        mayLetGo(
          findings.doubts.get(attendeeId),
          claim.inherited.has(attendeeId),
        )
      )
      .map(([attendeeId]) => attendeeId),
  );
  const unrecorded = new Set([...findings.unrecorded.values()].flat());
  return new Map(
    compact(
      heldPaymentRows(claim.held).map(({ attendeeId, sessionId }) =>
        settlementEntry(
          attendeeId,
          sessionId,
          lettingAttendees,
          unrecorded,
          findings,
          findings.claimPhases,
        )
      ),
    ),
  );
};

/** Treat every authoritative returned marker as unposted until ledger work
 * proves otherwise. This is the safe starting fact for every exit path. */
const initialUnrecorded = (
  attendees: readonly LoadedRefundAttendee[],
  claim: Extract<ClaimResult, { kind: "claimed" }>,
): Map<number, readonly string[]> => {
  const loaded = paymentReferenceRepresentations(attendees);
  const represented = new Map(
    [...loaded, ...[...claim.shared.values()].flat()].map((row) => [
      row.sessionId,
      row,
    ]),
  );
  const returned = [...represented.values()].filter(({ index }) =>
    claim.returned.has(index)
  );
  return new Map(
    [...Map.groupBy(returned, ({ attendeeId }) => attendeeId)].map(
      ([attendeeId, rows]) => [
        attendeeId,
        rows.map(({ sessionId }) => sessionId),
      ],
    ),
  );
};

/** Hold every attendee this run will touch, do the work, then let go. */
export const underAttendeeClaim = async <TResult>(
  rowClaim: RowClaim,
  attendees: readonly LoadedRefundAttendee[],
  listingId: number,
  run:
    & {
      blocked: (block: RefundRunBlock) => TResult;
      work: (heldWork: HeldRefundWork) => Promise<TResult>;
    }
    & (
      | {
        admit: RefundClaimAdmission;
        admissionRefused: () => TResult;
      }
      | { admit?: undefined; admissionRefused?: never }
    ),
): Promise<TResult> => {
  const claim = await rowClaim.claim(attendees, run.admit);
  if (claim.kind === "changed") {
    return run.blocked({
      kind: "payment_set_changed",
      reason:
        "the attendee or payment set changed while this refund was starting",
    });
  }
  if (claim.kind === "blocked") {
    return run.blocked({
      kind: "claim_held",
      reason: claimRefusal(claim.blockedBy),
    });
  }
  if (claim.kind === "not_admitted") {
    return requireValue(
      run.admissionRefused,
      "Refund claim refused without an admission gate",
    )();
  }
  const findings: RunFindings = {
    claimPhases: new Map(claim.phases),
    doubts: new Map(
      [...claim.inherited.keys()].map((attendeeId) => [attendeeId, "unread"]),
    ),
    recorded: new Set(),
    reviews: new Map(),
    unrecorded: initialUnrecorded(attendees, claim),
  };
  const settle = async (): Promise<void> => {
    await settleHold(
      rowClaim,
      {
        commandId: claim.commandId,
        heldSince: claim.heldSince,
        rows: settlementRows(claim, findings),
      },
      listingId,
    );
  };
  try {
    return await withSubrequestReserve(
      REFUND_SETTLEMENT_SUBREQUEST_RESERVE,
      () =>
        run.work({
          alreadyReturned: claim.returned,
          claim: {
            commandId: claim.commandId,
            held: claim.held,
            heldSince: claim.heldSince,
            phases: findings.claimPhases,
          },
          findings,
          inherited: claim.inherited,
          reviews: claim.reviews,
          shared: claim.shared,
          unrecorded: claim.unrecorded,
        }),
    );
  } finally {
    await settle();
  }
};
