/** Owner confirmation for retiring durable payment-review work. */

/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import { OWNER_FORM, requireOwnerOr } from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  getPaymentReviewStatus,
  type PaymentReviewStatus,
  resolvePaymentReview,
} from "#shared/db/payment-review.ts";
import { adminPaymentReviewPage } from "#templates/admin/attendees.tsx";
import {
  attendeeActionPage,
  attendeeActionUrlWithReturn,
  verifiedAttendeeAction,
} from "./attendees-route-helpers.ts";

/* jscpd:ignore-end */

const ACTION = "payment-review";

const REVIEW_GUARD = {
  available: null,
  blocked: t("admin.attendees.payment_review_in_progress"),
  none: t("admin.attendees.payment_review_none"),
} satisfies Record<PaymentReviewStatus, string | null>;

const handlePaymentReviewGet = attendeeActionPage(
  adminPaymentReviewPage,
  async ({ attendee }) =>
    REVIEW_GUARD[await getPaymentReviewStatus(attendee.id)],
  requireOwnerOr,
);

const handlePaymentReviewPost = verifiedAttendeeAction(
  ACTION,
  "payment review",
  async ({ attendee, listing }, form) => {
    const result = await resolvePaymentReview({
      attendeeId: attendee.id,
      listingId: listing.id,
    });
    const actionsUrl = `/admin/attendees/${attendee.id}/actions`;
    switch (result.kind) {
      case "resolved":
        return redirect(actionsUrl, t("success.payment_reviewed"), true, {
          form,
        });
      case "nothing_to_review":
        return redirect(
          actionsUrl,
          t("admin.attendees.payment_review_none"),
          true,
          { form, level: "info" },
        );
      case "claim_in_progress":
        return errorRedirect(
          attendeeActionUrlWithReturn(
            attendee.id,
            ACTION,
            form.getString("return_url"),
          ),
          t("admin.attendees.payment_review_in_progress"),
        );
    }
  },
  OWNER_FORM,
);

export const paymentReviewHandlers = defineRoutes({
  "GET /admin/attendees/:attendeeId/payment-review": handlePaymentReviewGet,
  "POST /admin/attendees/:attendeeId/payment-review": handlePaymentReviewPost,
});
