import { chunk } from "#fp";
import {
  type AnchoredAttendee,
  anchorLegacyCharges,
} from "#shared/db/payment-anchor/mint.ts";
import { isAnchorSession } from "#shared/db/payment-anchor/session.ts";
import {
  type ClaimResult,
  claimAttendeeRows,
  type RowRelease,
  releaseAttendeeRows,
} from "#shared/db/payment-claim.ts";
import {
  markPaymentReferencesProviderRefunded,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { reportRefundNotRecorded } from "#shared/invariant-errors.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { sendRefundIfAdmitted } from "#shared/payment/admit-refund.ts";
import { claimRefusal, mayReleaseClaim } from "#shared/payment/claim.ts";
import type { RefundCapability } from "#shared/payment/row-state.ts";
import { reportWithheldRefund } from "#shared/payment-review.ts";
import type { getActivePaymentProvider } from "#shared/payments.ts";
import { recordAttendeeRefundsBatch } from "#shared/refund-ledger.ts";
import type { RefundCandidate } from "./candidates.ts";
import {
  combineRefundOutcomes,
  packByReferenceCount,
  type RefundOutcome,
} from "./waves.ts";

type RefundProvider = Pick<
  NonNullable<Awaited<ReturnType<typeof getActivePaymentProvider>>>,
  "readChargeMoneyOrNull" | "refundCapability" | "refundPayment"
>;
type MarkReturnedReferences = (
  references: readonly RefundPaymentReference[],
) => Promise<void>;

/** Taking and letting go of the hold on an attendee's payment rows. Injected
 *  so the tally and ordering rules can be tested without a database. */
export type RowClaim = {
  claim: (
    attendeeIds: readonly number[],
    capability: RefundCapability,
  ) => Promise<ClaimResult>;
  release: (release: RowRelease) => Promise<void>;
};

/**
 * What a run decided about one attendee it held. An attendee named by neither
 * is settled and simply lets go.
 *
 * `in_doubt` is the only verdict that can keep a hold, and only against a
 * keyless provider: the call was made and not confirmed, so a retry could pay
 * twice. `unrecorded` is the opposite — the provider answered clearly and it
 * is our books that are behind, so the row says so and the hold goes. Keeping
 * the claim there would protect nothing the mark does not, while making the
 * attendee impossible to pick up, delete or merge for good.
 */
export type AttendeeVerdict = "in_doubt" | "unrecorded";

export const durableRowClaim: RowClaim = {
  claim: claimAttendeeRows,
  release: releaseAttendeeRows,
};

export type RefundCounts = {
  refundedCount: number;
  failedCount: number;
  /** The provider was asked and did not give a clear answer, so nobody knows
   *  whether the money moved. Never say it did. */
  errorCount: number;
  /** The money definitely went back and the ledger could not record it. This
   *  needs a correction, and must never be retried. */
  notRecordedCount: number;
};

const noRefunds = (failedCount = 0): RefundCounts => ({
  errorCount: 0,
  failedCount,
  notRecordedCount: 0,
  refundedCount: 0,
});

/** Max provider refund subrequests in flight at once. Bounds concurrency by
 * charge reference, not attendee: an attendee can carry several references (a
 * deposit plus a balance charge, or a merged attendee's combined charges), so
 * capping attendees alone could still fan a bulk refund out to far more
 * subrequests than an edge worker can safely hold open. Waves are packed by
 * reference count and each candidate's own references are chunked to this too.
 * The refresh-payment status check reuses it to bound its own fan-out. */
export const PROVIDER_REFUND_CONCURRENCY = 5;

/** Say that something went wrong with a refund on this listing. */
const reportRefundProblem = (detail: string, listingId: number): void =>
  logError({ code: ErrorCode.PAYMENT_REFUND, detail, listingId });

/** Log why one reference's money did not move, and report it as failed. */
const refusedRefund = (detail: string, listingId: number): RefundOutcome => {
  reportRefundProblem(detail, listingId);
  return "failed";
};

/** One reference's result. `unanswered` means the provider was asked and did
 *  not confirm, which is not the same as "it did not happen" — a lost response
 *  looks like a refusal from here, so a keyless run keeps its hold either
 *  way. A refund we never asked for does not set it. */
type ReferenceRefund = { outcome: RefundOutcome; unanswered: boolean };

/** Do the work at most once per key. Two attendees in one run can carry the
 *  same charge, and the hold cannot separate them because both rows belong to
 *  this run — so the second asker waits on the first's answer. */
const answeredOnce = <TAnswer>(
  asked: Map<string, Promise<TAnswer>>,
  key: string,
  ask: () => Promise<TAnswer>,
): Promise<TAnswer> => {
  const started = asked.get(key);
  if (started !== undefined) return started;
  const running = ask();
  asked.set(key, running);
  return running;
};

const refundReferenceOnce = async (
  provider: RefundProvider,
  candidate: RefundCandidate,
  listingId: number,
  reference: RefundPaymentReference,
  alreadyReturned: ReadonlySet<string>,
): Promise<ReferenceRefund> => {
  const attendeeId = candidate.attendee.id;
  const paymentReference = reference.reference;
  const settled = (outcome: RefundOutcome): ReferenceRefund => ({
    outcome,
    unanswered: false,
  });
  try {
    if (reference.refundState === "completed") return settled("refunded");
    // What the claimed row says now beats the reference list this run loaded
    // before it had the hold: another run may have refunded this since.
    if (alreadyReturned.has(reference.index)) return settled("refunded");
    // What the money has already done decides whether more is sent — see
    // `sendRefundIfAdmitted`. SumUp has no idempotency key to fall back on.
    return await sendRefundIfAdmitted(provider, paymentReference, {
      // Asked and not confirmed: it may never have happened, or the answer
      // may simply have been lost.
      failed: () => ({
        outcome: refusedRefund(
          `Admin refund failed for attendee ${attendeeId}, payment ${paymentReference}`,
          listingId,
        ),
        unanswered: true,
      }),
      sent: () => settled("refunded"),
      withhold: (admission) => {
        if (admission.kind === "already_returned") return settled("refunded");
        // How loudly this is said belongs to the one reporter that knows: an
        // unreachable provider is an answer, not an incident, and alerting on
        // it buries the disagreements that need somebody.
        reportWithheldRefund(admission, {
          attendeeId,
          listingId,
          paymentReference,
        });
        return settled("withheld");
      },
    });
  } catch (err) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund errored for attendee ${attendeeId}, payment ${paymentReference}: ${String(
        err,
      )}`,
      listingId,
    });
    // A throw is the same doubt as an unconfirmed answer: the call may have
    // landed before it failed.
    return { outcome: "errored", unanswered: true };
  }
};

/** Whether this attendee's rows may be let go. Only genuine doubt keeps a
 *  hold, and only against a provider where a repeat would pay twice. */
const mayLetGo = (
  verdict: AttendeeVerdict | undefined,
  capability: RefundCapability,
): boolean => verdict !== "in_doubt" || mayReleaseClaim(capability, "lost");

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

/** Hold every attendee this run will touch, do the work, then let go. One
 *  claim for the whole run costs the same two round trips as a single refund,
 *  and the run can never hold some of its attendees but not others. */
export const underAttendeeClaim = async <TResult>(
  rowClaim: RowClaim,
  held: readonly AnchoredAttendee[],
  capability: RefundCapability,
  listingId: number,
  run: {
    blocked: (reason: string) => TResult;
    verdicts: (result: TResult) => ReadonlyMap<number, AttendeeVerdict>;
    work: (alreadyReturned: ReadonlySet<string>) => Promise<TResult>;
  },
): Promise<TResult> => {
  // A charge with no row of its own cannot be held, and a claim that holds
  // nothing lets two runs both believe they have the money. Give it one first.
  await anchorLegacyCharges(held);
  // The payment sessions this run loaded. A hold covering anything else means
  // the attendee's money grew while the run was queued.
  const knownSessionIds = new Set(
    held.flatMap((attendee) =>
      attendee.references.flatMap((reference) => [...reference.sessionIds]),
    ),
  );
  const claim = await rowClaim.claim(
    held.map((attendee) => attendee.attendeeId),
    capability,
  );
  if (claim.kind === "blocked") {
    return run.blocked(claimRefusal(claim.blockedBy));
  }
  // The hold covers the rows that exist NOW. A payment this run never loaded
  // means refunding what we did load would return part of someone's money and
  // leave the rest, so the whole run stands down. An anchor is not such a
  // payment: it stands in for a charge this run already knows about, and the
  // reference list leaves its id out on purpose.
  const heldSessionIds = [...claim.held.values()].flat();
  const unknown = heldSessionIds.filter(
    (sessionId) =>
      !knownSessionIds.has(sessionId) && !isAnchorSession(sessionId),
  );
  if (unknown.length > 0) {
    await releaseHold(
      rowClaim,
      { heldSince: claim.heldSince, sessionIds: heldSessionIds },
      listingId,
    );
    return run.blocked(
      `a payment landed while this run was waiting (${unknown.length} not in the set it loaded)`,
    );
  }
  // A failed release leaves the claim standing until it goes stale, which is
  // recoverable; losing the answer the run just produced is not. So it is
  // reported, never allowed to replace the result or the original error.
  const settle = async (
    verdicts: ReadonlyMap<number, AttendeeVerdict>,
  ): Promise<void> => {
    const letting = [...claim.held].filter(([attendeeId]) =>
      mayLetGo(verdicts.get(attendeeId), capability),
    );
    await releaseHold(
      rowClaim,
      {
        heldSince: claim.heldSince,
        sessionIds: letting.flatMap(([, sessions]) => sessions),
        unrecorded: new Set(
          letting
            .filter(([attendeeId]) => verdicts.get(attendeeId) === "unrecorded")
            .flatMap(([, sessions]) => sessions),
        ),
      },
      listingId,
    );
  };
  try {
    const result = await run.work(claim.returned);
    await settle(run.verdicts(result));
    return result;
  } catch (error) {
    // Nothing is known about anybody, so every attendee is in doubt.
    await settle(new Map([...claim.held.keys()].map((id) => [id, "in_doubt"])));
    throw error;
  }
};

/** What one attendee's refund came to. `unsettled` means nothing durable
 *  proves what the money did, so the run keeps its hold: a keyless retry
 *  against evidence that has not caught up sends twice. */
export type CandidateRefund = {
  candidate: RefundCandidate;
  outcome: RefundOutcome;
  /** The charges that actually went back. On a whole refund this is every
   *  reference; on a partial one it is the part that moved, which the ledger
   *  reverses on its own rather than recording nothing. */
  returned: readonly RefundPaymentReference[];
  unsettled?: boolean;
};

export const refundCandidateAtProvider = async (
  provider: RefundProvider,
  candidate: RefundCandidate,
  listingId: number,
  markReturnedReferences: MarkReturnedReferences = markPaymentReferencesProviderRefunded,
  alreadyReturned: ReadonlySet<string> = new Set(),
  inFlight: Map<string, Promise<ReferenceRefund>> = new Map(),
): Promise<CandidateRefund> => {
  const results: {
    outcome: RefundOutcome;
    reference: RefundPaymentReference;
    unanswered: boolean;
  }[] = [];
  // Chunk this attendee's own references so a merged attendee carrying many
  // charges never fans out past the concurrency budget on its own.
  for (const group of chunk(PROVIDER_REFUND_CONCURRENCY)(
    candidate.references,
  )) {
    const groupResults = await Promise.all(
      group.map(async (reference) => ({
        ...(await answeredOnce(inFlight, reference.reference, () =>
          refundReferenceOnce(
            provider,
            candidate,
            listingId,
            reference,
            alreadyReturned,
          ),
        )),
        reference,
      })),
    );
    results.push(...groupResults);
  }
  const outcome = combineRefundOutcomes(
    results.map((result) => result.outcome),
  );
  const unanswered = results.some((result) => result.unanswered);
  const returnedReferences = results
    .filter((result) => result.outcome === "refunded")
    .map((result) => result.reference);
  try {
    await markReturnedReferences(returnedReferences);
  } catch (error) {
    reportRefundProblem(
      `Admin refund could not record returned payments for attendee ${candidate.attendee.id}: ${String(error)}`,
      listingId,
    );
    // Nothing durable says which charges came back, so the ledger must not be
    // told: a reversal it cannot re-derive is worse than one it never made.
    if (outcome !== "refunded") {
      return { candidate, outcome: "errored", returned: [] };
    }
    // The money went back but nothing records it. The refund still counts, so
    // the ledger still posts — but the run must not let go of its hold.
    return {
      candidate,
      outcome,
      returned: returnedReferences,
      unsettled: true,
    };
  }
  if (outcome !== "refunded" && candidate.references.length > 1) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund did not complete every payment for attendee ${candidate.attendee.id}`,
      listingId,
    });
  }
  return unanswered
    ? { candidate, outcome, returned: returnedReferences, unsettled: true }
    : { candidate, outcome, returned: returnedReferences };
};

const logBulkRefundProblem = (
  outcome: Exclude<RefundOutcome, "refunded" | "withheld">,
  candidate: RefundCandidate,
  listingId: number,
): void => {
  const refs = candidate.references
    .map((reference) => reference.reference)
    .join(", ");
  logError({
    code: ErrorCode.PAYMENT_REFUND,
    detail: `Admin bulk refund ${outcome} for attendee ${candidate.attendee.id}, payments ${refs}`,
    listingId,
  });
};

/** An attendee's charges that came back, and whether that was all of them. A
 *  post for a partial one records the money without calling the attendee
 *  refunded, because the rest of their charges are still with the provider. */
type LedgerPosting = AnchoredAttendee & { whole: boolean };

const tallyProviderRefund = (
  counts: RefundCounts,
  result: CandidateRefund,
  listingId: number,
  postings: LedgerPosting[],
): void => {
  const { candidate, outcome, returned } = result;
  if (outcome === "errored") {
    counts.errorCount++;
    logBulkRefundProblem(outcome, candidate, listingId);
  } else if (outcome === "failed") {
    counts.failedCount++;
    logBulkRefundProblem(outcome, candidate, listingId);
  } else if (outcome === "withheld") {
    // No money was sent, so it counts as not refunded — but the reason was
    // already said at the volume it deserved. Saying it again here as an
    // incident is how a provider outage fills the log with one error per
    // reference.
    counts.failedCount++;
  }
  // Whatever came back is recorded, whether or not the rest did. A refused
  // sibling used to strand its clean sibling's money with no ledger entry at
  // all; the ledger reverses the groups that moved and leaves the others.
  if (returned.length > 0) {
    postings.push({
      attendeeId: candidate.attendee.id,
      references: returned,
      whole: outcome === "refunded",
    });
  }
};

/**
 * Post whatever came back for one wave, and say how each attendee ended.
 *
 * A post that did not land is the one place a verdict is added rather than
 * read: the provider answered clearly, so there is no doubt to hold against,
 * only books that are behind. Doubt already recorded about the same attendee
 * outranks it, because there the money may not have moved at all.
 */
const recordWave = async (
  counts: RefundCounts,
  postings: readonly LedgerPosting[],
  verdicts: Map<number, AttendeeVerdict>,
  listingId: number,
): Promise<void> => {
  const posted = await recordAttendeeRefundsBatch(postings);
  for (const { attendeeId, whole } of postings) {
    if (posted.get(attendeeId) !== true) {
      // The provider sent this refund but our ledger could not record it —
      // report the broken promise per attendee, not just the aggregate count.
      counts.notRecordedCount++;
      reportRefundNotRecorded({ attendeeId, listingId });
      if (!verdicts.has(attendeeId)) verdicts.set(attendeeId, "unrecorded");
    } else if (whole) {
      counts.refundedCount++;
    }
  }
};

/** What a claimed run comes to: the tally, and what it decided about each
 *  attendee it held. */
type ClaimedRun = {
  counts: RefundCounts;
  verdicts: ReadonlyMap<number, AttendeeVerdict>;
};

/** Refund one chunk of attendees at the provider, then record full successes in
 * the ledger before starting the next chunk. */
export const processRefundBatch = async (
  provider: RefundProvider,
  batch: RefundCandidate[],
  listingId: number,
  rowClaim: RowClaim = durableRowClaim,
  markReturnedReferences: MarkReturnedReferences = markPaymentReferencesProviderRefunded,
): Promise<RefundCounts> => {
  const result = await underAttendeeClaim<ClaimedRun>(
    rowClaim,
    batch.map((candidate) => ({
      attendeeId: candidate.attendee.id,
      references: candidate.references,
    })),
    provider.refundCapability,
    listingId,
    {
      blocked: (reason) => {
        for (const candidate of batch) {
          reportRefundProblem(
            `Admin bulk refund not started for attendee ${candidate.attendee.id}: ${reason}`,
            listingId,
          );
        }
        return { counts: noRefunds(batch.length), verdicts: new Map() };
      },
      verdicts: (result) => result.verdicts,
      work: (alreadyReturned) =>
        refundClaimedBatch(
          provider,
          batch,
          listingId,
          markReturnedReferences,
          alreadyReturned,
        ),
    },
  );
  return result.counts;
};

const refundClaimedBatch = async (
  provider: RefundProvider,
  batch: RefundCandidate[],
  listingId: number,
  markReturnedReferences: MarkReturnedReferences,
  alreadyReturned: ReadonlySet<string>,
): Promise<ClaimedRun> => {
  const verdicts = new Map<number, AttendeeVerdict>();
  // Shared across the whole run, so a charge two attendees both carry is asked
  // about once.
  const inFlight = new Map<string, Promise<ReferenceRefund>>();
  const counts = noRefunds();
  for (const group of packByReferenceCount(PROVIDER_REFUND_CONCURRENCY)(
    batch,
  )) {
    const results = await Promise.all(
      group.map((candidate) =>
        refundCandidateAtProvider(
          provider,
          candidate,
          listingId,
          markReturnedReferences,
          alreadyReturned,
          inFlight,
        ),
      ),
    );
    const postings: LedgerPosting[] = [];
    for (const result of results) {
      // Nothing durable proves what this attendee's money did, so their rows
      // keep the hold against a keyless provider that would pay twice.
      if (result.unsettled === true) {
        verdicts.set(result.candidate.attendee.id, "in_doubt");
      }
      tallyProviderRefund(counts, result, listingId, postings);
    }
    await recordWave(counts, postings, verdicts, listingId);
  }
  return { counts, verdicts };
};
