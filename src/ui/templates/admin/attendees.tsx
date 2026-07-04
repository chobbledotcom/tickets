/**
 * Admin attendee page templates
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateRangeLabel, formatDatetimeShort } from "#shared/dates.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  bookingConflictLabel,
  bookingKey,
  hasBookingConflicts,
  nonConflictAnswerLabel,
} from "#shared/merge/attendee-merge.ts";
import type { AttendeeMergeDiff } from "#shared/merge/attendee-merge-types.ts";
import { paymentDashboardUrl } from "#shared/payment-dashboard.ts";
import type {
  AdminSession,
  Attendee,
  ListingWithCount,
} from "#shared/types.ts";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Badge } from "#templates/components/badge.tsx";
import {
  questionFieldset,
  questionWrapper,
} from "#templates/components/question-text.tsx";
import {
  RadioOption,
  type RadioOptionProps,
} from "#templates/components/radio-option.tsx";
import { ProseSection } from "#templates/public/unsubscribe.tsx";

/** A `<td>` cell holding one labelled radio option of a merge-decision group.
 *  The merge tables (PII fields, custom-question answers, booking conflicts)
 *  all render the same `<td><label><input type="radio"…/> {label}</label></td>`
 *  cell; this helper factors that out so a quorum target/source/clear cell
 *  can't drift between the three tables. */
const mergeRadioCell = ({
  name,
  value,
  checked,
  children,
}: RadioOptionProps): JSX.Element => (
  <td>
    <RadioOption checked={checked} name={name} value={value}>
      {" "}
      {children}
    </RadioOption>
  </td>
);

/** A merge-decision table: an optional heading + a scroll-wrapped table whose
 *  header row is the given column labels and whose body is the per-row decision
 *  markup. The PII-field, answer, and booking decision tables all share this
 *  shell. */
const DecisionTable = ({
  heading,
  headers,
  children,
}: {
  heading?: string;
  headers: Child[];
  children: Child;
}): JSX.Element => (
  <div>
    {heading !== undefined && heading !== "" && <h4>{heading}</h4>}
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  </div>
);

/** The "Amount paid: £X" paragraph, rendered when the attendee paid > 0. */
const amountPaidPara = (attendee: Attendee): JSX.Element | null =>
  Number.parseInt(attendee.price_paid, 10) > 0 ? (
    <p>
      <strong>{t("admin.attendees.amount_paid")}</strong>{" "}
      {formatCurrency(attendee.price_paid)}
    </p>
  ) : null;

/**
 * The prose "attendee details" block shared by the delete/refund/resend
 * confirmation pages: name, email, quantity, (optionally) amount paid,
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
}): JSX.Element => (
  <ProseSection heading={t("admin.attendees.details")}>
    <p>
      <strong>{t("admin.attendees.name")}</strong> {attendee.name}
    </p>
    <p>
      <strong>{t("admin.attendees.email")}</strong> {attendee.email}
    </p>
    <p>
      <strong>{t("admin.attendees.quantity")}</strong> {attendee.quantity}
    </p>
    {showAmountPaid && amountPaidPara(attendee)}
    <p>
      <strong>Registered:</strong> {formatDatetimeShort(attendee.created)}
    </p>
    {children}
  </ProseSection>
);

/** Shared ConfirmPage shell for the delete/refund/resend attendee action
 *  pages: all three wrap an {@link AttendeeDetails} body in a ConfirmPage with
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
  showAmountPaid?: boolean;
  titleAction: string;
  warningPrefix: string;
  warningText: string;
};

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
        <p>{t(config.confirmKey, { name: attendee.name })}</p>
        {config.body}
      </AttendeeDetails>
    ),
    danger: config.danger,
    error,
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
/** Build an attendee confirm-page renderer for a single action — the three
 *  admin delete/refund/resend pages share this signature, differing only in
 *  the route `segment` and the {@link attendeeConfirmPage} config. The
 *  wrapping `({ attendee }: {...}, session, returnUrl?, error?) => attendeeConfirmPage(...)`
 *  boilerplate was duplicated enough to trip jscpd; this factory keeps it in
 *  one place. */
const attendeeRouteConfirm =
  (segment: string, config: Omit<AttendeeConfirmConfig, "action">) =>
  (
    { attendee }: { listing: ListingWithCount; attendee: Attendee },
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
export const adminDeleteAttendeePage = attendeeRouteConfirm("delete", {
  body: (
    <>
      <label>
        <input checked name="release_bookings" type="checkbox" value="1" />{" "}
        {t("admin.attendees.release_bookings")}
      </label>
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
export const adminRefundAttendeePage = attendeeRouteConfirm("refund", {
  buttonText: t("admin.attendees.refund_submit"),
  confirmKey: "admin.attendees.refund_confirm",
  showAmountPaid: true,
  titleAction: "Refund Attendee",
  warningPrefix: "Warning",
  warningText:
    "This will issue a full refund for this attendee's payment. The attendee will remain registered.",
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
  /** The balance link targets the owner-only Balance tab, so callers gate it
   * on the viewer's role (never render a forbidden link). */
  showBalanceLink: boolean;
}): string => {
  if (!attendee.payment_id) return "";
  const isRefunded = attendee.refunded;
  const dashboardUrl = paymentDashboardUrl(attendee.payment_id);

  return String(
    <article>
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
            <strong>Balance outstanding:</strong>{" "}
            {formatCurrency(attendee.remaining_balance)}
            {showBalanceLink && (
              <>
                {" — "}
                <a href={`/admin/attendees/${attendee.id}/balance`}>
                  view balance &amp; payment link
                </a>
              </>
            )}
          </p>
        )}
      </div>
      <CsrfForm
        action={`/admin/attendees/${attendee.id}/refresh-payment`}
        class="inline"
      >
        <SubmitButton icon="rotate-ccw">
          {t("admin.attendees.refresh_payment")}
        </SubmitButton>
      </CsrfForm>
    </article>,
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
}: {
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
  selectedTextAnswers: Map<number, string>;
}): JSX.Element => (
  <>
    {questions.map((q) =>
      q.display_type === "free_text"
        ? questionWrapper(q, undefined, (labelledBy) => (
            <input
              aria-labelledby={labelledBy}
              maxlength={MAX_TEXTAREA_LENGTH}
              name={`question_${q.id}`}
              type="text"
              value={selectedTextAnswers.get(q.id) ?? ""}
            />
          ))
        : q.display_type === "select"
          ? questionWrapper(q, undefined, (labelledBy) => (
              <select aria-labelledby={labelledBy} name={`question_${q.id}`}>
                <option value="">No answer</option>
                {editableAnswers(q, selectedAnswerIds).map((a) => (
                  <option
                    selected={selectedAnswerIds.includes(a.id) || undefined}
                    value={String(a.id)}
                  >
                    {a.text}
                  </option>
                ))}
              </select>
            ))
          : questionFieldset(
              q,
              undefined,
              editableAnswers(q, selectedAnswerIds).map((a) => (
                <label>
                  <input
                    checked={selectedAnswerIds.includes(a.id)}
                    name={`question_${q.id}`}
                    type="radio"
                    value={String(a.id)}
                  />{" "}
                  {a.text}
                </label>
              )),
            ),
    )}
  </>
);

/** Source attendee data for the merge preview page */
type MergeSourceInfo = {
  id: number;
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  ticket_token: string;
  bookings: ListingAttendeeRow[];
};

/** Render a value as either plain text or a preformatted span */
const renderFieldValue = (value: string, multiline: boolean): string =>
  multiline
    ? String(<span style="white-space:pre-wrap">{value || "—"}</span>)
    : value || "—";

/** Render a PII field choice row (radio buttons for target vs source value) */
const MergePiiField = ({
  field,
  label,
  targetValue,
  sourceValue,
  multiline = false,
}: {
  field: string;
  label: string;
  targetValue: string;
  sourceValue: string;
  multiline?: boolean;
}): string => {
  const same = targetValue === sourceValue;
  const name = `pii_${field}`;
  return String(
    <tr>
      <th scope="row">{label}</th>
      {mergeRadioCell({
        checked: true,
        children: <Raw html={renderFieldValue(targetValue, multiline)} />,
        name,
        value: "target",
      })}
      <td>
        {same ? (
          <span class="muted">(same)</span>
        ) : (
          <RadioOption checked={false} name={name} value="source">
            {" "}
            <Raw html={renderFieldValue(sourceValue, multiline)} />
          </RadioOption>
        )}
      </td>
    </tr>,
  );
};

/** One row of the answer decision table: a `scope="row"` question-name header
 *  cell followed by the row's decision cell(s). Both the non-conflicting
 *  (info-only) and conflicting (radio) rows share this leading `<tr>`/`<th>`. */
const AnswerDecisionRow = ({
  children,
  questionText,
}: {
  children: Child;
  questionText: string;
}): JSX.Element => (
  <tr>
    <th scope="row">{questionText}</th>
    {children}
  </tr>
);

/** Render the answer decision table */
const MergeAnswersDecisionTable = ({
  diff,
  targetName,
  sourceName,
}: {
  diff: AttendeeMergeDiff;
  targetName: string;
  sourceName: string;
}): string => {
  if (diff.answerItems.length === 0) return "";
  return String(
    <DecisionTable
      headers={[
        t("terms.question"),
        `Keep (${targetName})`,
        `Take from (${sourceName})`,
        t("admin.attendees.th_clear"),
      ]}
      heading={t("admin.attendees.custom_question_answers")}
    >
      {diff.answerItems.map((item) => {
        const name = `answer_${item.questionId}`;
        if (!item.conflict) {
          // Non-conflicting: show info only (no decision needed)
          const { answer, from } = nonConflictAnswerLabel(item);
          return (
            <AnswerDecisionRow questionText={item.questionText}>
              <td colspan="3">
                <span class="muted">
                  {answer} ({from} — auto-kept)
                </span>
              </td>
            </AnswerDecisionRow>
          );
        }
        const targetLabel = item.targetAnswerText!;
        const sourceLabel = item.sourceAnswerText!;
        return (
          <AnswerDecisionRow questionText={item.questionText}>
            {mergeRadioCell({
              checked: true,
              children: targetLabel,
              name,
              value: "target",
            })}
            {mergeRadioCell({
              checked: false,
              children: sourceLabel,
              name,
              value: "source",
            })}
            {mergeRadioCell({
              checked: false,
              children: "None",
              name,
              value: "clear",
            })}
          </AnswerDecisionRow>
        );
      })}
    </DecisionTable>,
  );
};

/** One row of the booking decision table: the shared leading listing/date/qty
 *  cells followed by the row's status and (optionally) decision cells. Both the
 *  moveable and conflicting booking rows open with these same three cells. */
const BookingDecisionRow = ({
  children,
  dateStr,
  listingId,
  sourceQty,
}: {
  children: Child;
  dateStr: string;
  listingId: number;
  sourceQty: number;
}): JSX.Element => (
  <tr>
    <td>Listing #{listingId}</td>
    <td>{dateStr}</td>
    <td>{sourceQty}</td>
    {children}
  </tr>
);

/** Render the booking decision table */
const MergeBookingsDecisionTable = ({
  diff,
}: {
  diff: AttendeeMergeDiff;
}): string => {
  const hasConflicts = hasBookingConflicts(diff.bookingItems);
  const moveableExtraCell = hasConflicts ? String(<td />) : "";
  const headers = [
    t("terms.listing"),
    t("common.date"),
    t("admin.attendees.source_qty"),
    t("common.status"),
    ...(hasConflicts ? [t("admin.attendees.decision")] : []),
  ];

  return String(
    <DecisionTable
      headers={headers}
      heading={t("admin.attendees.listing_registrations")}
    >
      {diff.bookingItems.map((item) => {
        const key = bookingKey(
          item.listingId,
          item.startAt,
          item.parentListingId,
        );
        const name = `booking_${key}`;
        const dateStr = item.startAt
          ? formatDateRangeLabel(item.startAt, item.sourceBooking.end_at)
          : "—";

        if (item.conflictClass === "moveable") {
          return (
            <BookingDecisionRow
              dateStr={dateStr}
              listingId={item.listingId}
              sourceQty={item.sourceBooking.quantity}
            >
              <td>
                <span class="muted">Will be moved</span>
              </td>
              <Raw html={moveableExtraCell} />
            </BookingDecisionRow>
          );
        }

        const conflictLabel = bookingConflictLabel(item);
        const targetQty = item.targetBooking!.quantity;
        const sourceQty = item.sourceBooking.quantity;
        // The most either side's discarded ticket could be worth; >0 means
        // a payment is at stake, so decision 17 demands a credit/write-off.
        const moneyAtStake = Math.max(
          item.sourceSaleAmount,
          item.targetSaleAmount,
        );

        return (
          <BookingDecisionRow
            dateStr={dateStr}
            listingId={item.listingId}
            sourceQty={sourceQty}
          >
            <td>
              <strong>{conflictLabel}</strong>
              {item.targetBooking &&
                ` (target qty: ${targetQty}, source qty: ${sourceQty})`}
            </td>
            <td>
              <RadioOption checked name={name} value="keep_target">
                {" "}
                Keep target
              </RadioOption>
              <br />
              <RadioOption checked={false} name={name} value="take_source">
                {" "}
                Replace with source
              </RadioOption>
              <br />
              <RadioOption checked={false} name={name} value="skip_source">
                {" "}
                Skip source
              </RadioOption>
              {moneyAtStake > 0 && (
                <div class="merge-money-decision">
                  <p class="muted">
                    <strong>
                      {t("attendee_form.merge_discarded_payment_label")}
                    </strong>{" "}
                    (source {formatCurrency(item.sourceSaleAmount)}, target{" "}
                    {formatCurrency(item.targetSaleAmount)}) — this can't be
                    undone, so choose explicitly:
                  </p>
                  <RadioOption
                    checked={false}
                    name={`money_${key}`}
                    value="credit"
                  >
                    {" "}
                    Keep as the person's credit
                  </RadioOption>
                  <br />
                  <RadioOption
                    checked={false}
                    name={`money_${key}`}
                    value="writeoff"
                  >
                    {" "}
                    Write it off
                  </RadioOption>
                </div>
              )}
            </td>
          </BookingDecisionRow>
        );
      })}
    </DecisionTable>,
  );
};

/**
 * Attendee merge panel (the Actions tab) — search for a source attendee by
 * ticket token, then choose what to keep and confirm the merge.
 */
export const AttendeeMergePanel = (
  target: Attendee,
  source: MergeSourceInfo | null,
  searchToken: string | null,
  error?: string,
  mergeDiff?: AttendeeMergeDiff,
): JSX.Element => (
  <article>
    <Flash error={error} />

    <h3>{t("admin.attendees.merge_attendee")}</h3>

    {/* Token search form — GETs back to this tab with ?token=… */}
    <h4>{t("admin.attendees.search_by_token")}</h4>
    <form
      action={`/admin/attendees/${target.id}/actions`}
      class="inline-row"
      method="get"
    >
      <label for="token">
        Ticket token to merge from
        <input
          autofocus={!source}
          id="token"
          name="token"
          placeholder={t("attendee_form.enter_ticket_token_placeholder")}
          required
          type="text"
          value={searchToken || ""}
        />
      </label>
      <SubmitButton icon="search">
        {t("attendee_form.search_button")}
      </SubmitButton>
    </form>

    {source && mergeDiff && (
      <div>
        <div class="prose">
          <h3>{t("admin.attendees.merge_preview")}</h3>
          <p>
            Choose which value to keep for each field. Resolve any conflicts
            below. The source attendee will then be deleted.
          </p>
        </div>

        <CsrfForm action={`/admin/attendees/${target.id}/merge`}>
          <input
            name="source_token"
            type="hidden"
            value={source.ticket_token}
          />
          <input name="merge_version" type="hidden" value={mergeDiff.version} />

          {/* PII decisions */}
          <DecisionTable
            headers={[
              t("admin.attendees.field"),
              <>
                {"Keep (current): "}
                <strong>{target.name}</strong>
              </>,
              <>
                {"Take from: "}
                <strong>{source.name}</strong>
              </>,
            ]}
            heading=""
          >
            {mergeDiff.piiFields.map((f) => (
              <Raw
                html={MergePiiField({
                  field: f.field,
                  label: f.label,
                  multiline: f.multiline,
                  sourceValue: f.sourceValue,
                  targetValue: f.targetValue,
                })}
              />
            ))}
          </DecisionTable>

          {/* Answer decisions */}
          <Raw
            html={MergeAnswersDecisionTable({
              diff: mergeDiff,
              sourceName: source.name,
              targetName: target.name,
            })}
          />

          {/* Booking decisions */}
          <Raw html={MergeBookingsDecisionTable({ diff: mergeDiff })} />

          <p>
            <strong>Warning:</strong> This will permanently delete the source
            attendee. This action cannot be undone.
          </p>
          <SubmitButton class="danger" icon="trash-2">
            Merge and Delete Source Attendee
          </SubmitButton>
        </CsrfForm>
      </div>
    )}
  </article>
);
