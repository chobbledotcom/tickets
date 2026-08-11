import {
  type ClaimResult,
  claimAttendeeRows,
  type LoadedRefundAttendee,
} from "#shared/db/payment-claim/take.ts";
import {
  type RowRelease,
  releaseAttendeeRows,
} from "#shared/db/payment-claim.ts";
import { claimRefusal, mayReleaseClaim } from "#shared/payment/claim.ts";
import type {
  RefundCapability,
  ResolvedRefundCapability,
} from "#shared/payment/row-state.ts";
import { reportRefundProblem } from "./report.ts";

/** Taking and letting go of the hold on an attendee's payment rows. Injected
 *  so the tally and ordering rules can be tested without a database. */
export type RowClaim = {
  claim: (
    attendees: readonly LoadedRefundAttendee[],
    capability: RefundCapability,
  ) => Promise<ClaimResult>;
  release: (release: RowRelease) => Promise<void>;
};

/** What a run could not prove about one attendee's money. */
export type AttendeeDoubt = "in_doubt" | "unread";

/** What a run learnt about the attendees it held. */
export type RunFindings = {
  /** Attendees whose money this run could not account for. */
  doubts: Map<number, AttendeeDoubt>;
  /** Rows whose returned money the books have not caught up with. */
  unrecorded: Map<number, readonly string[]>;
};

/** Why a run could not take the complete set it loaded. */
export type RefundRunBlock =
  | { kind: "claim_held"; reason: string }
  | { kind: "payment_set_changed"; reason: string };

/** The exact durable hold provider preparation must bind before any send. */
export type HeldRefundClaim = Pick<
  Extract<ClaimResult, { kind: "claimed" }>,
  "held" | "heldSince"
>;

/** The facts protected by one complete attendee-row claim. */
export interface HeldRefundWork {
  readonly alreadyReturned: ReadonlySet<string>;
  readonly claim: HeldRefundClaim;
  readonly findings: RunFindings;
  readonly inherited: ReadonlyMap<number, ResolvedRefundCapability>;
}

export const durableRowClaim: RowClaim = {
  claim: claimAttendeeRows,
  release: releaseAttendeeRows,
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

/** Let go of a hold, reporting rather than raising when the row will not. */
const releaseHold = async (
  rowClaim: RowClaim,
  release: RowRelease,
  listingId: number,
): Promise<void> => {
  if (release.sessionIds.length === 0) return;
  try {
    await rowClaim.release(release);
  } catch (error) {
    reportRefundProblem(
      `Refund claim could not be released: ${String(error)}`,
      listingId,
    );
  }
};

/** Hold every attendee this run will touch, do the work, then let go. */
export const underAttendeeClaim = async <TResult>(
  rowClaim: RowClaim,
  held: readonly LoadedRefundAttendee[],
  capability: RefundCapability,
  listingId: number,
  run: {
    blocked: (block: RefundRunBlock) => TResult;
    work: (heldWork: HeldRefundWork) => Promise<TResult>;
  },
): Promise<TResult> => {
  const claim = await rowClaim.claim(held, capability);
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
  const findings: RunFindings = { doubts: new Map(), unrecorded: new Map() };
  const settle = async (): Promise<void> => {
    const unrecordedRowsFor = (attendeeId: number): readonly string[] => {
      const rows = findings.unrecorded.get(attendeeId);
      return rows === undefined ? [] : rows;
    };
    const letting = [...claim.held].filter(([attendeeId]) =>
      mayLetGo(
        findings.doubts.get(attendeeId),
        claim.inherited.has(attendeeId),
      ),
    );
    await releaseHold(
      rowClaim,
      {
        heldSince: claim.heldSince,
        sessionIds: letting.flatMap(([, sessions]) => sessions),
        unrecorded: new Set(
          letting.flatMap(([attendeeId]) => unrecordedRowsFor(attendeeId)),
        ),
      },
      listingId,
    );
  };
  const result = await run.work({
    alreadyReturned: claim.returned,
    claim: { held: claim.held, heldSince: claim.heldSince },
    findings,
    inherited: claim.inherited,
  });
  await settle();
  return result;
};
