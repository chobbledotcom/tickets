/** Listing-wide refund routes. */

/* jscpd:ignore-start -- imports */
import { compact } from "#fp";
import { t } from "#i18n";
import type { ListingRouteParams } from "#routes/admin/attendees-route-helpers.ts";
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import { getRefundCandidates } from "#routes/admin/refunds/candidates.ts";
import {
  processRefundBatch,
  type RefundBatchResult,
  type RefundCounts,
} from "#routes/admin/refunds/provider.ts";
import { refundReferenceProblemMessage } from "#routes/admin/refunds/readiness-problem.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { ownerFormById } from "#routes/entity.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { decryptPiiBlob } from "#shared/db/attendees/pii.ts";
import {
  getListingWithCount,
  getListingWithCountPrimary,
} from "#shared/db/listings/records.ts";
import {
  getRefundAllSummary,
  loadRefundAllBatch,
  type RefundAllSummary,
} from "#shared/db/refund-all-candidates.ts";
import type { FormParams } from "#shared/form-data.ts";
import { fail, ok } from "#shared/response.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { adminRefundAllAttendeesPage } from "#templates/admin/attendees.tsx";

/* jscpd:ignore-end */

const REFUND_ALL_BLOCKER_MESSAGES = {
  legacy_unindexed: t("error.payment_history_incomplete"),
  owner_review: t("error.payment_needs_review"),
  provider_refund: t("error.refund_recovery_required"),
  unrecorded_money: t("error.refund_not_recorded"),
} satisfies Record<Exclude<RefundAllSummary["blockedBy"], null>, string>;

const refundAllBlockerMessage = (
  blockedBy: RefundAllSummary["blockedBy"],
): string | null =>
  blockedBy === null ? null : REFUND_ALL_BLOCKER_MESSAGES[blockedBy];

const handleAdminRefundAllGet = (
  request: Request,
  { id }: ListingRouteParams,
): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const listing = await getListingWithCount(id);
    if (listing === null) return notFoundResponse();
    const flash = applyFlash(request);
    const summary = await getRefundAllSummary(id);
    const blocker = refundAllBlockerMessage(summary.blockedBy);
    const { total } = summary;
    return total === 0
      ? htmlResponse(
          adminRefundAllAttendeesPage(
            listing,
            {
              count: 0,
              error: flash.error ?? t("error.no_attendees_to_refund"),
              kind: "unavailable",
            },
            session,
          ),
          400,
        )
      : htmlResponse(
          adminRefundAllAttendeesPage(
            listing,
            blocker === null
              ? { count: total, error: flash.error, kind: "available" }
              : {
                  count: total,
                  error: compact([flash.error, blocker]).join(" "),
                  kind: "unavailable",
                },
            session,
          ),
        );
  });

interface RefundResponseContext {
  counts: RefundCounts;
  listing: ListingWithCount;
  refundAllUrl: string;
  remaining: number;
  totalRefundable: number;
}

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

const remainingRefundMessage = (
  remaining: number,
  pendingCount: number,
): string | null => {
  const otherRemaining = remaining - pendingCount;
  if (pendingCount === 0) {
    return t("admin.attendees.refund_all_result_remaining", {
      count: remaining,
    });
  }
  return otherRemaining === 0
    ? null
    : t("admin.attendees.refund_all_result_waiting_remaining", {
        count: otherRemaining,
      });
};

/** Build the error response branch of a bulk refund. */
const buildRefundProblemResponse = async (
  context: RefundResponseContext,
): Promise<Response> => {
  const { listing, refundAllUrl, counts, remaining } = context;
  const { refundedCount, failedCount, notRecordedCount } = counts;
  // An unrecorded refund is operator work, so count it as an error.
  const errorCount = notRecordedCount;
  const problemCount = failedCount + errorCount;
  const msg = compact([
    t("admin.attendees.refund_all_result_refunds", {
      count: refundedCount,
    }),
    t("admin.attendees.refund_all_result_failures", {
      count: problemCount,
    }),
    errorCount > 0
      ? t("admin.attendees.refund_all_result_errors", { count: errorCount })
      : null,
    // Admission permits one unresolved payment outcome. Incomplete local work
    // on an older return would have blocked before this response.
    remainingRefundMessage(remaining, 0),
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

/** Build the final response for a bulk refund. */
const buildRefundAllResponse = async (
  context: RefundResponseContext,
): Promise<Response> => {
  const { counts, listing, refundAllUrl, remaining, totalRefundable } = context;
  const refundedCount = counts.refundedCount;
  const hasProblems = counts.failedCount + counts.notRecordedCount > 0;

  if (hasProblems) {
    return buildRefundProblemResponse({
      counts,
      listing,
      refundAllUrl,
      remaining,
      totalRefundable,
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
        remainingRefundMessage(remaining, counts.pendingCount),
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

const processRefundAll = async (
  listing: ListingWithCount,
  form: FormParams,
): Promise<Response> => {
  const refundAllUrl = `/admin/listing/${listing.id}/refund-all`;
  const error = verifyOrRedirect(
    form,
    listing.name,
    refundAllUrl,
    "Listing name",
  );
  if (error) return error;

  const batch = await loadRefundAllBatch(listing.id);
  const blocker = refundAllBlockerMessage(batch.blockedBy);
  if (blocker !== null) return fail(refundAllUrl, blocker);
  const privateKey = await requireRequestPrivateKey();
  const loaded = await getRefundCandidates(
    await Promise.all(
      batch.attendees.map(async (attendee) => ({
        ...attendee,
        payment_id: (await decryptPiiBlob(attendee.pii_blob, privateKey, true))
          .payment_id,
      })),
    ),
    privateKey,
  );
  if (loaded.kind !== "complete") {
    return fail(refundAllUrl, refundReferenceProblemMessage(loaded));
  }
  const refundable = loaded.candidates;

  if (batch.total === 0) {
    return fail(refundAllUrl, t("error.no_attendees_to_refund"));
  }
  if (refundable.length !== batch.attendees.length) {
    throw new Error("Refund All candidate set changed while it was loading");
  }

  const result: RefundBatchResult = await processRefundBatch(
    refundable,
    listing.id,
    { audience: "bulk" },
  );
  if (result.kind === "blocked") {
    return buildBlockedRefundResponse(listing, refundAllUrl, batch.total);
  }
  if (result.kind === "not_ready") {
    return fail(refundAllUrl, result.message);
  }
  return buildRefundAllResponse({
    counts: result.counts,
    listing,
    refundAllUrl,
    remaining: batch.total - result.counts.refundedCount,
    totalRefundable: batch.total,
  });
};

const handleAdminRefundAllPost = ownerFormById(async (id, _session, form) => {
  const listing = await getListingWithCountPrimary(id);
  return listing === null
    ? notFoundResponse()
    : processRefundAll(listing, form);
});

/** Routes that refund every eligible attendee on a listing. */
export const bulkRefundHandlers = defineRoutes({
  "GET /admin/listing/:id/refund-all": handleAdminRefundAllGet,
  "POST /admin/listing/:id/refund-all": handleAdminRefundAllPost,
});
