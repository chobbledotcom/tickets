/**
 * Admin attendee refund routes (single + bulk)
 */

import { chunk, filter, unique } from "#fp";
import { t } from "#i18n";
import {
  withDecryptedAttendees,
  withListingAttendeesAuth,
} from "#routes/admin/actions.ts";
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import { AUTH_FORM, type AuthSession, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { hasActiveBookingLine } from "#shared/db/attendees.ts";
import {
  getRefundPaymentReferences,
  hasRefundPaymentReference,
} from "#shared/db/processed-payments.ts";
import type { FormParams } from "#shared/form-data.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { getActivePaymentProvider } from "#shared/payments.ts";
import {
  recordAttendeeRefund,
  recordAttendeeRefundsBatch,
} from "#shared/refund-ledger.ts";
import { fail, ok } from "#shared/response.ts";
import {
  type Attendee,
  hasTicketQuantity,
  type ListingWithCount,
} from "#shared/types.ts";
import {
  adminRefundAllAttendeesPage,
  adminRefundAttendeePage,
} from "#templates/admin/attendees.tsx";
import {
  attendeeActionPage,
  attendeeActionUrl,
  type ListingRouteParams,
  NO_PROVIDER_ERROR,
  verifiedAttendeeAction,
} from "./attendees-route-helpers.ts";

/** Max refunds per request to stay within Bunny Edge fetch limits */
const REFUND_BATCH_LIMIT = 30;

type PaymentProvider = NonNullable<
  Awaited<ReturnType<typeof getActivePaymentProvider>>
>;

type RefundCandidate = {
  attendee: Attendee;
  references: string[];
};

/** Render refund error redirect for a single attendee, keeping the caller's
 * return_url threaded through so a retry still lands back where it started. */
const refundError = (
  attendeeId: number,
  msg: string,
  returnUrl = "",
): Response =>
  errorRedirect(
    `${attendeeActionUrl(attendeeId, "refund")}${
      returnUrl ? `?return_url=${encodeURIComponent(returnUrl)}` : ""
    }`,
    msg,
  );

/** Handle GET /admin/attendees/:attendeeId/refund. The guard blocks (no
 * payment, already refunded, or a no-quantity ghost home line) render the
 * page with a message at 400; the clean GET renders the flashed error (if
 * any) at 200 — attendeeActionPage supplies exactly that shape. */
const handleAdminAttendeeRefundGet = attendeeActionPage(
  adminRefundAttendeePage,
  async (data) => {
    // The no-payment branch also covers a no-quantity ghost home line: the
    // guard runs against the exact (attendee, home listing) row, so a refund
    // can't fire for a non-booking.
    if (!(await hasActiveBookingLine(data.attendee.id, data.listing.id))) {
      return t("error.no_payment_to_refund");
    }
    if (data.attendee.refunded) {
      return t("error.already_refunded");
    }
    if (!(await hasRefundPaymentReference(data.attendee))) {
      return t("error.no_payment_to_refund");
    }
    return null;
  },
);

/** Handle POST /admin/attendees/:attendeeId/refund */
const handleAttendeeRefund = verifiedAttendeeAction(
  "refund",
  "refund",
  async (data, form) => {
    const attendeeId = data.attendee.id;
    const listingId = data.listing.id;
    const returnUrl = form.getString("return_url");
    // Refuse a refund on a no-quantity ghost home line (checked against the
    // exact (attendee, home listing) pair) rather than refunding the payment
    // for a non-booking.
    if (!(await hasActiveBookingLine(attendeeId, listingId))) {
      return refundError(
        attendeeId,
        t("error.no_payment_to_refund"),
        returnUrl,
      );
    }
    if (data.attendee.refunded) {
      return refundError(attendeeId, t("error.already_refunded"), returnUrl);
    }
    const references = (await getRefundPaymentReferences([data.attendee])).get(
      attendeeId,
    )!;
    if (references.length === 0) {
      return refundError(
        attendeeId,
        t("error.no_payment_to_refund"),
        returnUrl,
      );
    }

    const provider = await getActivePaymentProvider();
    if (!provider) {
      return refundError(attendeeId, NO_PROVIDER_ERROR, returnUrl);
    }

    const refunded = await refundAtProvider(
      provider,
      { attendee: data.attendee, references },
      listingId,
    );
    if (refunded.outcome !== "refunded") {
      return refundError(attendeeId, t("error.refund_failed"), returnUrl);
    }

    const { posted } = await recordAttendeeRefund(attendeeId);
    await logActivity(
      `Refund issued for attendee '${data.attendee.name}'`,
      listingId,
      attendeeId,
    );
    // The provider refund succeeded; if the ledger post missed (refund status is
    // now ledger-only), surface it so the admin makes a manual adjustment rather
    // than re-refunding an already-refunded payment.
    if (!posted) {
      return refundError(attendeeId, t("error.refund_not_recorded"), returnUrl);
    }
    // Honor the caller's return_url (e.g. the attendee page's Actions tab);
    // fall back to that tab otherwise.
    return redirect(
      `/admin/attendees/${attendeeId}/actions`,
      t("success.refund_issued"),
      true,
      { form },
    );
  },
);

/** Attendees refundable on this listing: at least one recorded charge reference,
 * not yet refunded, and a real ticket line — a no-quantity ghost row on this
 * listing isn't refundable (its roster row carries this listing's quantity). */
const getRefundCandidates = async (
  attendees: Attendee[],
): Promise<RefundCandidate[]> => {
  const referencesByAttendee = await getRefundPaymentReferences(attendees);
  return filter(
    (candidate: RefundCandidate) =>
      candidate.references.length > 0 &&
      !candidate.attendee.refunded &&
      hasTicketQuantity(candidate.attendee),
  )(
    attendees.map((attendee) => ({
      attendee,
      references: referencesByAttendee.get(attendee.id)!,
    })),
  );
};

/** Handle GET /admin/listing/:id/refund-all */
const handleAdminRefundAllGet = (
  request: Request,
  { id }: ListingRouteParams,
): Promise<Response> =>
  withListingAttendeesAuth(request, id, async (listing, attendees, session) => {
    const flash = applyFlash(request);
    const count = (await getRefundCandidates(attendees)).length;
    return count === 0
      ? htmlResponse(
          adminRefundAllAttendeesPage(
            listing,
            0,
            session,
            flash.error ?? t("error.no_attendees_to_refund"),
          ),
          400,
        )
      : htmlResponse(
          adminRefundAllAttendeesPage(listing, count, session, flash.error),
        );
  });

type RefundOutcome = "refunded" | "failed" | "errored";
type RefundCounts = {
  refundedCount: number;
  failedCount: number;
  errorCount: number;
};

/**
 * Refund one attendee at the provider — the network I/O safe to run in parallel.
 * Provider errors are caught per attendee, so one failure never aborts the
 * batch. No DB write happens here: refund status is now projected from the
 * `refund_cash` ledger leg, which {@link processRefundBatch} posts serially via
 * {@link recordAttendeeRefund} to avoid concurrent write-transaction contention.
 */
const refundReferenceAtProvider = async (
  provider: PaymentProvider,
  candidate: RefundCandidate,
  listingId: number,
  reference: string,
): Promise<RefundOutcome> => {
  const attendeeId = candidate.attendee.id;
  try {
    if (await provider.refundPayment(reference)) return "refunded";
    if (await provider.isPaymentRefunded(reference)) return "refunded";
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund failed for attendee ${attendeeId}, payment ${reference}`,
      listingId,
    });
    return "failed";
  } catch (err) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund errored for attendee ${attendeeId}, payment ${reference}: ${String(err)}`,
      listingId,
    });
    return "errored";
  }
};

const combineRefundOutcomes = (outcomes: RefundOutcome[]): RefundOutcome => {
  if (outcomes.includes("errored")) return "errored";
  if (outcomes.includes("failed")) return "failed";
  return "refunded";
};

const refundAtProvider = async (
  provider: PaymentProvider,
  candidate: RefundCandidate,
  listingId: number,
): Promise<{ candidate: RefundCandidate; outcome: RefundOutcome }> => {
  const outcomes = await Promise.all(
    unique(candidate.references).map((reference) =>
      refundReferenceAtProvider(provider, candidate, listingId, reference),
    ),
  );
  const outcome = combineRefundOutcomes(outcomes);
  if (outcome !== "refunded" && candidate.references.length > 1) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Admin refund did not complete every payment for attendee ${candidate.attendee.id}`,
      listingId,
    });
  }
  return { candidate, outcome };
};

const logBulkRefundProblem = (
  outcome: Exclude<RefundOutcome, "refunded">,
  candidate: RefundCandidate,
  listingId: number,
): void => {
  const refs = candidate.references.join(", ");
  logError({
    code: ErrorCode.PAYMENT_REFUND,
    detail: `Admin bulk refund ${outcome} for attendee ${candidate.attendee.id}, payments ${refs}`,
    listingId,
  });
};

const tallyProviderRefund = (
  counts: RefundCounts,
  candidate: RefundCandidate,
  outcome: RefundOutcome,
  listingId: number,
  refundedIds: number[],
): void => {
  if (outcome === "errored") {
    counts.errorCount++;
    logBulkRefundProblem(outcome, candidate, listingId);
  } else if (outcome === "failed") {
    counts.failedCount++;
    logBulkRefundProblem(outcome, candidate, listingId);
  } else {
    refundedIds.push(candidate.attendee.id);
  }
};

/**
 * Process a batch of refundable attendees and tally results. Provider refunds run
 * in parallel within each chunk; then — before issuing the next chunk's provider
 * refunds — that chunk's successes are recorded in the ledger in one transaction
 * (see {@link recordAttendeeRefundsBatch}), so an edge timeout mid-batch can't
 * leave a completed provider refund without its `refund_cash` leg (a retry would
 * see it already-refunded and never re-post). The per-attendee interactive write
 * is avoided because it contends the single SQLite writer (SQLITE_BUSY) at scale.
 * A missed post is tallied as errored, not refunded: refund status is ledger-only
 * now, so it must surface rather than leave the payment silently re-refundable.
 * Never 500s — neither helper throws.
 */
const processRefundBatch = async (
  provider: PaymentProvider,
  batch: RefundCandidate[],
  listingId: number,
): Promise<RefundCounts> => {
  const REFUND_CHUNK_SIZE = 5;
  const counts: RefundCounts = {
    errorCount: 0,
    failedCount: 0,
    refundedCount: 0,
  };
  for (const group of chunk(REFUND_CHUNK_SIZE)(batch)) {
    const results = await Promise.all(
      group.map((candidate) =>
        refundAtProvider(provider, candidate, listingId),
      ),
    );
    const chunkRefundedIds: number[] = [];
    for (const { candidate, outcome } of results) {
      tallyProviderRefund(
        counts,
        candidate,
        outcome,
        listingId,
        chunkRefundedIds,
      );
    }
    // Record this chunk's ledger reversals before moving on to the next chunk's
    // provider refunds, narrowing the window where a completed provider refund
    // has no ledger leg.
    const posted = await recordAttendeeRefundsBatch(chunkRefundedIds);
    for (const ok of posted.values()) {
      if (ok) counts.refundedCount++;
      else counts.errorCount++;
    }
  }
  return counts;
};

type RefundResponseCtx = {
  listing: ListingWithCount;
  refundAllUrl: string;
  counts: RefundCounts;
  remaining: number;
};

/** Build the error response branch of a bulk refund (some refunds failed). */
const buildRefundProblemResponse = async (
  ctx: RefundResponseCtx,
): Promise<Response> => {
  const { listing, refundAllUrl, counts, remaining } = ctx;
  const { refundedCount, failedCount, errorCount } = counts;
  const problemCount = failedCount + errorCount;
  const errorNote =
    errorCount > 0
      ? ` (${errorCount} errored — check the activity log for details)`
      : "";
  const msg =
    remaining > 0
      ? `${refundedCount} refund(s) succeeded, ${problemCount} failed${errorNote}. ${remaining} remaining — submit again to continue.`
      : `${refundedCount} refund(s) succeeded, ${problemCount} failed${errorNote}. Some payments may have already been refunded.`;
  await logActivity(
    `Bulk refund: ${refundedCount} succeeded, ${problemCount} failed for '${listing.name}'`,
    listing.id,
  );
  return fail(refundAllUrl, msg);
};

/** Build the final response for a bulk refund based on tallied results. */
const buildRefundAllResponse = async (
  ctx: RefundResponseCtx & { totalRefundable: number },
): Promise<Response> => {
  const { counts, listing, refundAllUrl, totalRefundable, remaining } = ctx;
  const refundedCount = counts.refundedCount;
  const hasProblems = counts.failedCount + counts.errorCount > 0;

  if (hasProblems) {
    return buildRefundProblemResponse({
      counts,
      listing,
      refundAllUrl,
      remaining,
    });
  }

  if (remaining > 0) {
    await logActivity(
      `Bulk refund: ${refundedCount} of ${totalRefundable} refunded for '${listing.name}'`,
      listing.id,
    );
    return ok(
      refundAllUrl,
      `${refundedCount} attendee(s) refunded. ${remaining} remaining — submit again to continue.`,
    );
  }

  await logActivity(
    `Bulk refund: all ${refundedCount} attendee(s) refunded for '${listing.name}'`,
    listing.id,
  );
  return ok(`/admin/listing/${listing.id}`, t("success.all_refunded"));
};

/** Process bulk refund for all refundable attendees */
const processRefundAll = async (
  listing: ListingWithCount,
  attendees: Attendee[],
  _session: AuthSession,
  form: FormParams,
): Promise<Response> => {
  const refundAllUrl = `/admin/listing/${listing.id}/refund-all`;
  const refundable = await getRefundCandidates(attendees);
  const error = verifyOrRedirect(
    form,
    listing.name,
    refundAllUrl,
    "Listing name",
  );
  if (error) return error;

  if (refundable.length === 0) {
    return fail(refundAllUrl, t("error.no_attendees_to_refund"));
  }

  const provider = await getActivePaymentProvider();
  if (!provider) {
    return fail(refundAllUrl, NO_PROVIDER_ERROR);
  }

  const batch = refundable.slice(0, REFUND_BATCH_LIMIT);
  const remaining = refundable.length - batch.length;
  const counts = await processRefundBatch(provider, batch, listing.id);
  return buildRefundAllResponse({
    counts,
    listing,
    refundAllUrl,
    remaining,
    totalRefundable: refundable.length,
  });
};

/** Handle POST /admin/listing/:id/refund-all */
const handleAdminRefundAllPost = (
  request: Request,
  { id }: ListingRouteParams,
): Promise<Response> =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withDecryptedAttendees(session, id, (listing, attendees) =>
      processRefundAll(listing, attendees, session, form),
    ),
  );

/** Attendee refund routes */
export const attendeeRefundRoutes = defineRoutes({
  "GET /admin/attendees/:attendeeId/refund": handleAdminAttendeeRefundGet,
  "GET /admin/listing/:id/refund-all": handleAdminRefundAllGet,
  "POST /admin/attendees/:attendeeId/refund": handleAttendeeRefund,
  "POST /admin/listing/:id/refund-all": handleAdminRefundAllPost,
});
