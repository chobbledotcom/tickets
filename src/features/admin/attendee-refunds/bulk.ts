/** Listing-wide refund routes. */

/* jscpd:ignore-start -- imports */
import { compact } from "#fp";
import { t } from "#i18n";
import { withDecryptedAttendees } from "#routes/admin/actions.ts";
import type { ListingRouteParams } from "#routes/admin/attendees-route-helpers.ts";
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import { getRefundCandidates } from "#routes/admin/refunds/candidates.ts";
import {
  processRefundBatch,
  type RefundBatchResult,
  type RefundCounts,
} from "#routes/admin/refunds/provider.ts";
import { type AuthSession, requireOwnerOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { ownerFormById } from "#routes/entity.ts";
import { htmlResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import type { FormParams } from "#shared/form-data.ts";
import { fail, ok } from "#shared/response.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { adminRefundAllAttendeesPage } from "#templates/admin/attendees.tsx";

/* jscpd:ignore-end */

const handleAdminRefundAllGet = (
  request: Request,
  { id }: ListingRouteParams,
): Promise<Response> =>
  requireOwnerOr(request, (session) =>
    withDecryptedAttendees(session, id, async (listing, attendees) => {
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
    }),
  );

interface RefundResponseContext {
  counts: RefundCounts;
  listing: ListingWithCount;
  refundAllUrl: string;
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

/** Build the error response branch of a bulk refund. */
const buildRefundProblemResponse = async (
  context: RefundResponseContext,
): Promise<Response> => {
  const { listing, refundAllUrl, counts } = context;
  const { refundedCount, failedCount, notRecordedCount, pendingCount } = counts;
  // An unrecorded refund is operator work, so count it as an error.
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
    t("admin.attendees.refund_all_result_complete"),
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
  const { counts, listing, refundAllUrl } = context;
  const refundedCount = counts.refundedCount;
  const hasProblems =
    counts.failedCount + counts.errorCount + counts.notRecordedCount > 0;

  if (hasProblems) {
    return buildRefundProblemResponse({
      counts,
      listing,
      refundAllUrl,
    });
  }

  if (counts.pendingCount > 0) {
    await logActivity(
      `Bulk refund: ${refundActivityCounts(counts)} for '${listing.name}'`,
      listing.id,
    );
    return ok(
      refundAllUrl,
      [
        t("admin.attendees.refund_all_result_refunds", {
          count: refundedCount,
        }),
        t("admin.attendees.refund_all_result_pending", {
          count: counts.pendingCount,
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

  const result: RefundBatchResult = await processRefundBatch(
    refundable,
    listing.id,
    { audience: "bulk" },
  );
  if (result.kind === "blocked") {
    return buildBlockedRefundResponse(listing, refundAllUrl, refundable.length);
  }
  if (result.kind === "not_ready") {
    return fail(refundAllUrl, result.message);
  }
  return buildRefundAllResponse({
    counts: result.counts,
    listing,
    refundAllUrl,
  });
};

const handleAdminRefundAllPost = ownerFormById((id, session, form) =>
  withDecryptedAttendees(session, id, (listing, attendees) =>
    processRefundAll(listing, attendees, session, form),
  ),
);

/** Routes that refund every eligible attendee on a listing. */
export const bulkRefundHandlers = defineRoutes({
  "GET /admin/listing/:id/refund-all": handleAdminRefundAllGet,
  "POST /admin/listing/:id/refund-all": handleAdminRefundAllPost,
});
