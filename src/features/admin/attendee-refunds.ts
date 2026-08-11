import { defineRoutes } from "#routes/router.ts";
/**
 * Admin attendee refund routes (single + bulk)
 */

/* jscpd:ignore-start */
import { compact, requiredMapValue } from "#fp";
import { t } from "#i18n";
import {
  withDecryptedAttendees,
  withListingAttendeesAuth,
} from "#routes/admin/actions.ts";
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import type { AuthSession } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { hasActiveBookingLine } from "#shared/db/attendees/queries.ts";
import {
  getRefundPaymentReferences,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import type { FormParams } from "#shared/form-data.ts";
import { fail, ok } from "#shared/response.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { BULK_REFUND_LIMIT } from "#shared/subrequest-budget.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import {
  adminRefundAllAttendeesPage,
  adminRefundAttendeePage,
} from "#templates/admin/attendees.tsx";
import {
  attendeeActionPage,
  attendeeActionUrlWithReturn,
  type ListingRouteParams,
  verifiedAttendeeAction,
} from "./attendees-route-helpers.ts";
import {
  getRefundCandidates,
  refundWorkRemains,
} from "./refunds/candidates.ts";
import {
  processRefundBatch,
  type RefundBatchResult,
  type RefundCounts,
} from "./refunds/provider.ts";

/* jscpd:ignore-end */

/** Render refund error redirect for a single attendee, keeping the caller's
 * return_url threaded through so a retry still lands back where it started. */
const refundError = (
  attendeeId: number,
  msg: string,
  returnUrl: string,
): Response =>
  errorRedirect(
    attendeeActionUrlWithReturn(attendeeId, "refund", returnUrl),
    msg,
  );

/** Handle GET /admin/attendees/:attendeeId/refund. The guard blocks (no
 * payment, already refunded, or a no-quantity ghost home line) render the
 * page with a message at 400; the clean GET renders the flashed error (if
 * any) at 200 — attendeeActionPage supplies exactly that shape. */
/** What is left to refund for this attendee, or the reason nothing is. Both
 *  the page guard and the POST ask it, so the page a person is looking at and
 *  the action they submit can never disagree about whether a refund is still
 *  possible. */
type RefundableCharges =
  | { kind: "nothing"; reason: string }
  | { kind: "refundable"; references: RefundPaymentReference[] };

const whatIsLeftToRefund = async (
  attendee: Attendee,
): Promise<RefundableCharges> => {
  const references = requiredMapValue(
    await getRefundPaymentReferences(
      [attendee],
      await requireRequestPrivateKey(),
    ),
    attendee.id,
    `No refund references read for attendee ${attendee.id}`,
  );
  // The ledger's flag alone is not the answer: a part refund still leaves
  // money to send back, and a hold left behind still needs a run to take it
  // off. Asked through the same rule the bulk list uses, so this page and that
  // one cannot disagree.
  if (!refundWorkRemains(attendee, references)) {
    return { kind: "nothing", reason: t("error.already_refunded") };
  }
  return references.length === 0
    ? { kind: "nothing", reason: t("error.no_payment_to_refund") }
    : { kind: "refundable", references };
};

const handleAdminAttendeeRefundGet = attendeeActionPage(
  adminRefundAttendeePage,
  async (data) => {
    // The no-payment branch also covers a no-quantity ghost home line: the
    // guard runs against the exact (attendee, home listing) row, so a refund
    // can't fire for a non-booking.
    if (!(await hasActiveBookingLine(data.attendee.id, data.listing.id))) {
      return t("error.no_payment_to_refund");
    }
    const left = await whatIsLeftToRefund(data.attendee);
    return left.kind === "nothing" ? left.reason : null;
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
    const left = await whatIsLeftToRefund(data.attendee);
    if (left.kind === "nothing") {
      return refundError(attendeeId, left.reason, returnUrl);
    }
    const references = left.references;

    // One attendee is a run of one, through the very same path a wave takes.
    // The ledger post has to happen while the hold is still on, and a run of
    // one is no less exposed to a merge landing mid-refund than a run of fifty.
    const result = await processRefundBatch(
      [{ attendee: data.attendee, references }],
      listingId,
    );
    if (result.kind === "blocked") {
      return refundError(attendeeId, t("error.refund_pending"), returnUrl);
    }
    if (result.kind === "not_ready") {
      return refundError(attendeeId, result.message, returnUrl);
    }
    const { counts } = result;
    if (counts.refundedCount !== 1) {
      // The run already reported whichever way it went; this only tells the
      // operator which. Only a confirmed refund the ledger could not record
      // says "do not send this again" — a provider that gave no clear answer
      // has not told us the money moved.
      return refundError(
        attendeeId,
        counts.notRecordedCount === 1
          ? t("error.refund_not_recorded")
          : counts.pendingCount === 1
            ? t("error.refund_pending")
            : t("error.refund_failed"),
        returnUrl,
      );
    }
    await logActivity(
      `Refund issued for attendee '${data.attendee.name}'`,
      listingId,
      attendeeId,
    );
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

/** Handle GET /admin/listing/:id/refund-all */
const handleAdminRefundAllGet = (
  request: Request,
  { id }: ListingRouteParams,
): Promise<Response> =>
  withListingAttendeesAuth(request, id, async (listing, attendees, session) => {
    const flash = applyFlash(request);
    const count = (
      await getRefundCandidates(attendees, await requireRequestPrivateKey())
    ).length;
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

type RefundResponseCtx = {
  listing: ListingWithCount;
  refundAllUrl: string;
  counts: RefundCounts;
  remaining: number;
};

const buildBlockedRefundResponse = async (
  listing: ListingWithCount,
  refundAllUrl: string,
  totalRefundable: number,
): Promise<Response> => {
  await logActivity(
    `Bulk refund: not started because another refund is still settling for '${listing.name}'`,
    listing.id,
  );
  return fail(
    refundAllUrl,
    [
      t("error.refund_pending"),
      t("admin.attendees.refund_all_result_remaining", {
        count: totalRefundable,
      }),
    ].join(" "),
  );
};

const refundActivityCounts = (
  counts: RefundCounts,
  failedCount?: number,
): string =>
  compact([
    `${counts.refundedCount} succeeded`,
    counts.pendingCount > 0 ? `${counts.pendingCount} still settling` : null,
    failedCount === undefined ? null : `${failedCount} failed`,
  ]).join(", ");

/** Build the error response branch of a bulk refund (some refunds failed). */
const buildRefundProblemResponse = async (
  ctx: RefundResponseCtx,
): Promise<Response> => {
  const { listing, refundAllUrl, counts, remaining } = ctx;
  const { refundedCount, failedCount, notRecordedCount, pendingCount } = counts;
  // A refund the ledger never recorded is a problem the operator has to act
  // on, so it is counted with the errors rather than passing as a success.
  const errorCount = counts.errorCount + notRecordedCount;
  const problemCount = failedCount + errorCount;
  const msg = compact([
    t("admin.attendees.refund_all_result_refunds", {
      count: refundedCount,
    }),
    pendingCount > 0
      ? t("admin.attendees.refund_all_result_pending", {
          count: pendingCount,
        })
      : null,
    t("admin.attendees.refund_all_result_failures", {
      count: problemCount,
    }),
    errorCount > 0
      ? t("admin.attendees.refund_all_result_errors", { count: errorCount })
      : null,
    t(
      remaining > 0
        ? "admin.attendees.refund_all_result_remaining"
        : "admin.attendees.refund_all_result_complete",
      { count: remaining },
    ),
  ]).join(" ");
  await logActivity(
    `Bulk refund: ${refundActivityCounts(
      counts,
      problemCount,
    )} for '${listing.name}'`,
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
  const hasProblems =
    counts.failedCount + counts.errorCount + counts.notRecordedCount > 0;

  if (hasProblems) {
    return buildRefundProblemResponse({
      counts,
      listing,
      refundAllUrl,
      remaining,
    });
  }

  if (counts.pendingCount > 0) {
    await logActivity(
      `Bulk refund: ${refundActivityCounts(counts)} for '${listing.name}'`,
      listing.id,
    );
    return ok(
      refundAllUrl,
      compact([
        t("admin.attendees.refund_all_result_refunds", {
          count: refundedCount,
        }),
        t("admin.attendees.refund_all_result_pending", {
          count: counts.pendingCount,
        }),
        remaining > 0
          ? t("admin.attendees.refund_all_result_remaining", {
              count: remaining,
            })
          : null,
      ]).join(" "),
    );
  }

  if (remaining > 0) {
    await logActivity(
      `Bulk refund: ${refundedCount} of ${totalRefundable} refunded for '${listing.name}'`,
      listing.id,
    );
    return ok(
      refundAllUrl,
      [
        t("admin.attendees.refund_all_result_refunds", {
          count: refundedCount,
        }),
        t("admin.attendees.refund_all_result_remaining", {
          count: remaining,
        }),
      ].join(" "),
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
  const refundable = await getRefundCandidates(
    attendees,
    await requireRequestPrivateKey(),
  );
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

  const batch = refundable.slice(0, BULK_REFUND_LIMIT);
  const remaining = refundable.length - batch.length;
  const result: RefundBatchResult = await processRefundBatch(batch, listing.id);
  if (result.kind === "blocked") {
    return buildBlockedRefundResponse(listing, refundAllUrl, refundable.length);
  }
  if (result.kind === "not_ready") {
    return fail(refundAllUrl, result.message);
  }
  const { counts } = result;
  return buildRefundAllResponse({
    counts,
    listing,
    refundAllUrl,
    remaining,
    totalRefundable: refundable.length,
  });
};

/** Handle POST /admin/listing/:id/refund-all */
const handleAdminRefundAllPost = createAuthedHandler<ListingRouteParams>({
  handle: ({ form, params, session }) =>
    withDecryptedAttendees(session, params.id, (listing, attendees) =>
      processRefundAll(listing, attendees, session, form),
    ),
});

/** Attendee refund routes */
export const adminHandlers = defineRoutes({
  "GET /admin/attendees/:attendeeId/refund": handleAdminAttendeeRefundGet,
  "GET /admin/listing/:id/refund-all": handleAdminRefundAllGet,
  "POST /admin/attendees/:attendeeId/refund": handleAttendeeRefund,
  "POST /admin/listing/:id/refund-all": handleAdminRefundAllPost,
});
