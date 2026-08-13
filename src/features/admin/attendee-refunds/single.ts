/** Single-attendee refund routes. */

/* jscpd:ignore-start -- imports */
import { requiredMapValue } from "#fp";
import { t } from "#i18n";
import {
  attendeeActions,
  type AttendeeWithListing,
} from "#routes/admin/attendees-route-helpers.ts";
import { refundWorkRemains } from "#routes/admin/refunds/candidates.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import { OWNER_FORM, requireOwnerOr } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { hasActiveBookingLine } from "#shared/db/attendees/queries.ts";
import {
  getRefundPaymentReferences,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { getPaymentWorkStatus } from "#shared/db/payment-review.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";
import {
  adminBlockedRefundAttendeePage,
  adminRefundAttendeePage,
} from "#templates/admin/attendees.tsx";
import { refundError, singleRefundResultError } from "./single-result.ts";

/* jscpd:ignore-end */

type RefundableCharges =
  | { kind: "nothing"; reason: string }
  | { kind: "unsafe"; reason: string }
  | { kind: "refundable"; references: RefundPaymentReference[] };

/** What remains, shared by the page guard and submitted action. */
const whatIsLeftToRefund = async (
  attendee: Attendee,
): Promise<RefundableCharges> => {
  const work = await getPaymentWorkStatus(attendee.id);
  const workReason = {
    clear: null,
    moving: t("error.refund_pending"),
    needs_money_record: t("error.refund_not_recorded"),
    needs_provider_recovery: t("error.refund_recovery_required"),
    needs_review: t("error.payment_needs_review"),
  } satisfies Record<
    Awaited<ReturnType<typeof getPaymentWorkStatus>>,
    string | null
  >;
  if (workReason[work] !== null) {
    return { kind: "unsafe", reason: workReason[work] };
  }
  const referenceSet = requiredMapValue(
    await getRefundPaymentReferences(
      [{ currentPaymentId: attendee.payment_id, id: attendee.id }],
      await requireRequestPrivateKey(),
    ),
    attendee.id,
    `No refund references read for attendee ${attendee.id}`,
  );
  if (referenceSet.kind !== "complete") {
    return {
      kind: "unsafe",
      reason: t(
        referenceSet.kind === "legacy_unindexed"
          ? "error.payment_history_incomplete"
          : "error.payment_history_too_large",
      ),
    };
  }
  const references = referenceSet.references;
  // A part refund still leaves money to send back, while a leftover hold still
  // needs a run to remove it. Use the same rule as the bulk candidate list.
  if (!refundWorkRemains(attendee, references)) {
    return { kind: "nothing", reason: t("error.already_refunded") };
  }
  return references.length === 0
    ? { kind: "nothing", reason: t("error.no_payment_to_refund") }
    : { kind: "refundable", references };
};

interface RefundPageState {
  page: typeof adminRefundAttendeePage;
  reason: string | null;
}

const getRefundPageState = async (
  data: AttendeeWithListing,
): Promise<RefundPageState> => {
  if (!(await hasActiveBookingLine(data.attendee.id, data.listing.id))) {
    return {
      page: adminRefundAttendeePage,
      reason: t("error.no_payment_to_refund"),
    };
  }
  const left = await whatIsLeftToRefund(data.attendee);
  return {
    page: left.kind === "unsafe"
      ? adminBlockedRefundAttendeePage
      : adminRefundAttendeePage,
    reason: left.kind === "refundable" ? null : left.reason,
  };
};

const handleAdminAttendeeRefundGet = attendeeActions.refund.page(
  async (data, ...args) => (await getRefundPageState(data)).page(data, ...args),
  async (data) => (await getRefundPageState(data)).reason,
  requireOwnerOr,
);

const handleAttendeeRefund = attendeeActions.refund.verified(
  "refund",
  async (data, form) => {
    const attendeeId = data.attendee.id;
    const listingId = data.listing.id;
    const returnUrl = form.getString("return_url");
    // An attendee needs this exact live booking line before its payment can be
    // refunded from this listing.
    if (!(await hasActiveBookingLine(attendeeId, listingId))) {
      return refundError(
        attendeeId,
        t("error.no_payment_to_refund"),
        returnUrl,
      );
    }
    const left = await whatIsLeftToRefund(data.attendee);
    if (left.kind === "unsafe") {
      return refundError(attendeeId, left.reason, returnUrl, "actions");
    }
    if (left.kind === "nothing") {
      return refundError(attendeeId, left.reason, returnUrl);
    }

    // A run of one follows the same claim and ledger path as a bulk wave.
    const result = await processRefundBatch(
      [{ attendee: data.attendee, references: left.references }],
      listingId,
      { audience: "single" },
    );
    const resultError = await singleRefundResultError(
      result,
      attendeeId,
      returnUrl,
    );
    if (resultError) return resultError;
    await logActivity("Refund issued", listingId, attendeeId);
    return redirect(
      `/admin/attendees/${attendeeId}/actions`,
      t("success.refund_issued"),
      true,
      { form },
    );
  },
  OWNER_FORM,
);

/** Routes that refund one attendee. */
export const singleRefundHandlers = defineRoutes({
  "GET /admin/attendees/:attendeeId/refund": handleAdminAttendeeRefundGet,
  "POST /admin/attendees/:attendeeId/refund": handleAttendeeRefund,
});
