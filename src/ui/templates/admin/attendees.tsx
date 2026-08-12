/**
 * Admin attendee page templates
 */

/* jscpd:ignore-start */
import { compact } from "#fp";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import type {
  QuestionWithAnswers,
  SelectedQuestionAnswers,
} from "#shared/db/question-types.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { paymentDashboardUrl } from "#shared/payment-dashboard.ts";
import type {
  AdminSession,
  Attendee,
  ListingWithCount,
} from "#shared/types.ts";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { CheckboxLabel } from "#templates/components/aggregate-sections.tsx";
import { Badge } from "#templates/components/badge.tsx";
import {
  type LabelledLine,
  LabelledParas,
} from "#templates/components/labelled-para.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { ProseSection } from "#templates/components/prose-section.tsx";
import { questionControl } from "#templates/components/question-controls.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";

/* jscpd:ignore-end */

/** The "Amount paid: £X" paragraph, rendered when the attendee paid > 0. */
const amountPaidPara = (attendee: Attendee): JSX.Element | null =>
  Number.parseInt(attendee.price_paid, 10) > 0 ? (
    <p>
      <strong>{t("admin.attendees.amount_paid")}</strong>{" "}
      {formatCurrency(attendee.price_paid)}
    </p>
  ) : null;

/**
 * The prose "attendee details" block shared by attendee confirmation pages:
 * name, email, quantity, (optionally) amount paid,
 * registered timestamp, then any page-specific trailing children.
 */
const AttendeeDetails = ({
  attendee,
  showAmountPaid,
  children,
}: {
  attendee: Attendee;
  showAmountPaid?: boolean;
  children?: Child;
}): JSX.Element => {
  // Only shown when the caller asked for it and the person actually paid,
  // matching the old `showAmountPaid && amountPaidPara(...)` guard.
  const amountPaidLine: LabelledLine | null =
    showAmountPaid && Number.parseInt(attendee.price_paid, 10) > 0
      ? {
          label: t("admin.attendees.amount_paid"),
          value: formatCurrency(attendee.price_paid),
        }
      : null;
  return (
    <ProseSection title={t("admin.attendees.details")}>
      <LabelledParas
        items={compact([
          { label: t("admin.attendees.name"), value: attendee.name },
          { label: t("admin.attendees.email"), value: attendee.email },
          { label: t("admin.attendees.quantity"), value: attendee.quantity },
          amountPaidLine,
          {
            label: t("admin.attendees.registered"),
            value: formatDatetimeShort(attendee.created),
          },
        ])}
      />
      {children}
    </ProseSection>
  );
};

/** Shared ConfirmPage shell for attendee action pages: each wraps an
 *  {@link AttendeeDetails} body in a ConfirmPage with
 *  the same active/label/name/returnUrl/warning structure. Only the action,
 *  title, button text, confirm message, and body children differ — those are
 *  passed via the config. The `warning` paragraph wraps a `<strong>` prefix
 *  (e.g. "Warning:") followed by the caller's text. */
/** Config object passed to {@link attendeeConfirmPage} (and built by
 *  {@link attendeeRouteConfirm}). The caller supplies everything except the
 *  `action` URL — the route factory injects that from its `segment` arg. */
type AttendeeConfirmConfig = {
  action: string;
  body?: JSX.Element;
  buttonText: string;
  confirmKey: string;
  danger?: boolean;
  disabled?: boolean;
  hiddenFields?: Record<string, string>;
  showAmountPaid?: boolean;
  titleAction: string;
  warningPrefix: string;
  warningText: string;
};

// Calls ConfirmPage directly: the extra returnUrl argument doesn't fit the
// (entity, session, error?) shape entityDeletePage builds.
const attendeeConfirmPage = (
  attendee: Attendee,
  session: AdminSession,
  error: string | undefined,
  returnUrl: string | undefined,
  config: AttendeeConfirmConfig,
): string =>
  ConfirmPage({
    action: config.action,
    active: "/admin/",
    buttonText: config.buttonText,
    children: (
      <AttendeeDetails
        attendee={attendee}
        {...(config.showAmountPaid ? { showAmountPaid: true } : {})}
      >
        {!config.disabled && (
          <p>{t(config.confirmKey, { name: attendee.name })}</p>
        )}
        {config.body}
      </AttendeeDetails>
    ),
    danger: config.danger,
    disabled: config.disabled,
    error,
    hiddenFields: config.hiddenFields,
    label: t("admin.attendees.delete_label"),
    name: attendee.name,
    returnUrl,
    session,
    title: `${config.titleAction}: ${attendee.name}`,
    warning: (
      <p>
        <strong>{config.warningPrefix}:</strong> {config.warningText}
      </p>
    ),
  });
/** Build an attendee confirm-page renderer for a single action. The action
 *  pages share this signature, differing only in
 *  the route `segment` and the {@link attendeeConfirmPage} config. The
 *  wrapping `({ attendee }: {...}, session, returnUrl?, error?) => attendeeConfirmPage(...)`
 *  boilerplate was duplicated enough to trip jscpd; this factory keeps it in
 *  one place. */
const attendeeRouteConfirm =
  (segment: string, config: Omit<AttendeeConfirmConfig, "action">) =>
  (
    { attendee }: { attendee: Attendee },
    session: AdminSession,
    returnUrl?: string,
    error?: string,
  ): string =>
    attendeeConfirmPage(attendee, session, error, returnUrl, {
      ...config,
      action: `/admin/attendees/${attendee.id}/${segment}`,
    });

/**
 * Admin delete attendee confirmation page
 */
export const adminAttendeeDeletePage = attendeeRouteConfirm("delete", {
  body: (
    <>
      <CheckboxLabel
        checked
        label={` ${t("admin.attendees.release_bookings")}`}
        name="release_bookings"
        value="1"
      />
      <p>
        <small>{t("admin.attendees.release_bookings_note")}</small>
      </p>
    </>
  ),
  buttonText: t("admin.attendees.delete_submit"),
  confirmKey: "admin.attendees.delete_confirm",
  titleAction: "Delete Attendee",
  warningPrefix: "Warning",
  warningText:
    "This will permanently remove this attendee from the listing and delete any associated payment records.",
});

/**
 * Admin refund attendee confirmation page
 */
const refundConfirm: Omit<AttendeeConfirmConfig, "action"> = {
  buttonText: t("admin.attendees.refund_submit"),
  confirmKey: "admin.attendees.refund_confirm",
  showAmountPaid: true,
  titleAction: "Refund Attendee",
  warningPrefix: "Warning",
  warningText:
    "This will issue a full refund for this attendee's payment. The attendee will remain registered.",
};

export const adminRefundAttendeePage = attendeeRouteConfirm(
  "refund",
  refundConfirm,
);

/** Explain why a refund is blocked without leaving a send form on the page. */
export const adminBlockedRefundAttendeePage = attendeeRouteConfirm("refund", {
  ...refundConfirm,
  disabled: true,
});

/** Record that the owner has handled an ambiguous payment outcome. */
const paymentReviewConfirm = {
  buttonText: t("admin.attendees.payment_review_submit"),
  confirmKey: "admin.attendees.payment_review_confirm",
  titleAction: t("admin.attendees.payment_review_title"),
  warningPrefix: t("admin.attendees.payment_review_warning_prefix"),
  warningText: t("admin.attendees.payment_review_warning"),
} satisfies Omit<AttendeeConfirmConfig, "action">;

/** Render the exact review case loaded with the attendee action. */
export const adminPaymentReviewPage = (
  attendee: Attendee,
  reviewIdentity: string | null,
  session: AdminSession,
  returnUrl?: string,
  error?: string,
): string =>
  attendeeConfirmPage(attendee, session, error, returnUrl, {
    ...paymentReviewConfirm,
    action: `/admin/attendees/${attendee.id}/payment-review`,
    disabled: reviewIdentity === null,
    ...(reviewIdentity === null
      ? {}
      : { hiddenFields: { review_identity: reviewIdentity } }),
  });

/**
 * Admin re-send notification confirmation page
 */
export const adminResendNotificationPage = attendeeRouteConfirm(
  "resend-notification",
  {
    buttonText: t("admin.attendees.resend_submit"),
    confirmKey: "admin.attendees.resend_confirm",
    danger: false,
    showAmountPaid: true,
    titleAction: "Re-send Notification",
    warningPrefix: "Note",
    warningText:
      "This will re-send the registration notification for this attendee.",
  },
);

/**
 * Admin refund all attendees confirmation page
 */
export const adminRefundAllAttendeesPage = (
  listing: ListingWithCount,
  refundableCount: number,
  session: AdminSession,
  error?: string,
): string =>
  ConfirmPage({
    action: `/admin/listing/${listing.id}/refund-all`,
    active: "/admin/",
    buttonText: t("admin.attendees.refund_all_submit"),
    children: (
      <p>{t("admin.attendees.refund_all_confirm", { name: listing.name })}</p>
    ),
    error,
    label: t("admin.attendees.refund_all_label"),
    name: listing.name,
    session,
    title: `Refund All: ${listing.name}`,
    warning: (
      <p>
        <Raw
          html={t("admin.attendees.refund_all_warning", {
            count: refundableCount,
          })}
        />
      </p>
    ),
  });

/** Render payment details section (read-only). Shared by the unified
 * add/edit attendee form. */
export const PaymentDetails = ({
  attendee,
  showBalanceLink,
}: {
  attendee: Attendee;
  /** The balance link targets the owner-only Ledger tab, so callers gate it
   * on the viewer's role (never render a forbidden link). */
  showBalanceLink: boolean;
}): JSX.Element | null => {
  if (!attendee.payment_id) return null;
  const isRefunded = attendee.refunded;
  const dashboardUrl = paymentDashboardUrl(attendee.payment_id);

  return (
    <PageBlock>
      <div class="prose">
        <h3>{t("admin.attendees.payment_details")}</h3>
        <p>
          <strong>{t("admin.attendees.payment_id")}</strong>{" "}
          {dashboardUrl ? (
            <a href={dashboardUrl} rel="noopener" target="_blank">
              {attendee.payment_id}
            </a>
          ) : (
            attendee.payment_id
          )}
        </p>
        {amountPaidPara(attendee)}
        <p>
          <strong>{t("admin.attendees.refund_status")}</strong>{" "}
          {isRefunded ? (
            <Badge variant="alert">{t("admin.attendees.refunded")}</Badge>
          ) : (
            t("admin.attendees.not_refunded")
          )}
        </p>
        {attendee.remaining_balance > 0 && (
          <p>
            <strong>{t("admin.attendees.balance_outstanding")}</strong>{" "}
            {formatCurrency(attendee.remaining_balance)}
            {showBalanceLink && (
              <>
                {" — "}
                <a href={`/admin/attendees/${attendee.id}/ledger`}>
                  {t("admin.attendees.view_ledger_payment_link")}
                </a>
              </>
            )}
          </p>
        )}
      </div>
      <SaveForm
        action={`/admin/attendees/${attendee.id}/refresh-payment`}
        class="inline"
        submitIcon="rotate-ccw"
        submitLabel={t("admin.attendees.refresh_payment")}
      />
    </PageBlock>
  );
};

/** Render custom question fields with pre-selected answers for admin edit.
 * Shared by the unified add/edit attendee form.
 *
 * Question text may contain markdown — simple text is used as a clickable
 * label; complex markdown is rendered as a prose block above the control. */
/** The answers to offer for a question in the admin edit form: every active
 *  answer plus any inactive one the attendee already has selected (so a
 *  previously chosen, now-deactivated answer is never silently dropped). */
const editableAnswers = (q: QuestionWithAnswers, selectedAnswerIds: number[]) =>
  q.answers.filter((a) => a.active || selectedAnswerIds.includes(a.id));

export const EditQuestions = ({
  questions,
  selectedAnswerIds,
  selectedTextAnswers,
}: SelectedQuestionAnswers): JSX.Element => (
  <>
    {questions.map((q) =>
      questionControl(q, {
        isChosen: (answerId) => selectedAnswerIds.includes(answerId),
        options: editableAnswers(q, selectedAnswerIds),
        placeholder: t("attendee_form.no_answer"),
        // A saved free-text answer may legitimately not exist yet.
        textValue: selectedTextAnswers.get(q.id) ?? "",
      }),
    )}
  </>
);
