/**
 * Admin attendee page templates
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateRangeLabel, formatDatetimeShort } from "#shared/dates.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { ConfirmForm, CsrfForm, Flash } from "#shared/forms.tsx";
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
import { AdminNav } from "#templates/admin/nav.tsx";
import { BackButton, SubmitButton } from "#templates/components/actions.tsx";
import {
  questionFieldset,
  questionWrapper,
} from "#templates/components/question-text.tsx";
import { Layout } from "#templates/layout.tsx";

/**
 * Admin delete attendee confirmation page
 */
export const adminDeleteAttendeePage = (
  { listing, attendee }: { listing: ListingWithCount; attendee: Attendee },
  session: AdminSession,
  returnUrl?: string,
  error?: string,
): string =>
  String(
    <Layout title={`Delete Attendee: ${attendee.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/listing/${listing.id}/attendee/${attendee.id}/delete`}
        buttonText={t("admin.attendees.delete_submit")}
        label={t("admin.attendees.delete_label")}
        name={attendee.name}
        returnUrl={returnUrl}
      >
        <p>
          <strong>Warning:</strong> This will permanently remove this attendee
          from the listing and delete any associated payment records.
        </p>
        <div class="prose">
          <h2>{t("admin.attendees.details")}</h2>
          <p>
            <strong>{t("admin.attendees.name")}</strong> {attendee.name}
          </p>
          <p>
            <strong>{t("admin.attendees.email")}</strong> {attendee.email}
          </p>
          <p>
            <strong>{t("admin.attendees.quantity")}</strong> {attendee.quantity}
          </p>
          <p>
            <strong>Registered:</strong> {formatDatetimeShort(attendee.created)}
          </p>
          <label>
            <input checked name="release_bookings" type="checkbox" value="1" />{" "}
            {t("admin.attendees.release_bookings")}
          </label>
          <p>
            <small>{t("admin.attendees.release_bookings_note")}</small>
          </p>
          <p>{t("admin.attendees.delete_confirm", { name: attendee.name })}</p>
        </div>
      </ConfirmForm>
    </Layout>,
  );

/**
 * Admin refund attendee confirmation page
 */
export const adminRefundAttendeePage = (
  { listing, attendee }: { listing: ListingWithCount; attendee: Attendee },
  session: AdminSession,
  error?: string,
  returnUrl?: string,
): string =>
  String(
    <Layout title={`Refund Attendee: ${attendee.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/listing/${listing.id}/attendee/${attendee.id}/refund`}
        buttonText={t("admin.attendees.refund_submit")}
        label={t("admin.attendees.delete_label")}
        name={attendee.name}
        returnUrl={returnUrl}
      >
        <p>
          <strong>Warning:</strong> This will issue a full refund for this
          attendee's payment. The attendee will remain registered.
        </p>
        <div class="prose">
          <h2>{t("admin.attendees.details")}</h2>
          <p>
            <strong>{t("admin.attendees.name")}</strong> {attendee.name}
          </p>
          <p>
            <strong>{t("admin.attendees.email")}</strong> {attendee.email}
          </p>
          <p>
            <strong>{t("admin.attendees.quantity")}</strong> {attendee.quantity}
          </p>
          {Number.parseInt(attendee.price_paid, 10) > 0 && (
            <p>
              <strong>{t("admin.attendees.amount_paid")}</strong>{" "}
              {formatCurrency(attendee.price_paid)}
            </p>
          )}
          <p>
            <strong>Registered:</strong> {formatDatetimeShort(attendee.created)}
          </p>
          <p>{t("admin.attendees.refund_confirm", { name: attendee.name })}</p>
        </div>
      </ConfirmForm>
    </Layout>,
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
  String(
    <Layout title={`Refund All: ${listing.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/listing/${listing.id}/refund-all`}
        buttonText={t("admin.attendees.refund_all_submit")}
        label={t("admin.attendees.refund_all_label")}
        name={listing.name}
      >
        <p>
          <Raw
            html={t("admin.attendees.refund_all_warning", {
              count: refundableCount,
            })}
          />
        </p>
        <p>{t("admin.attendees.refund_all_confirm", { name: listing.name })}</p>
      </ConfirmForm>
    </Layout>,
  );

/** Render payment details section (read-only). Shared by the unified
 * add/edit attendee form. */
export const PaymentDetails = ({
  attendee,
}: {
  attendee: Attendee;
}): string => {
  if (!attendee.payment_id) return "";
  const pricePaid = Number.parseInt(attendee.price_paid, 10);
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
        {pricePaid > 0 && (
          <p>
            <strong>{t("admin.attendees.amount_paid")}</strong>{" "}
            {formatCurrency(attendee.price_paid)}
          </p>
        )}
        <p>
          <strong>{t("admin.attendees.refund_status")}</strong>{" "}
          {isRefunded ? (
            <span class="badge-alert">{t("admin.attendees.refunded")}</span>
          ) : (
            t("admin.attendees.not_refunded")
          )}
        </p>
        {attendee.remaining_balance > 0 && (
          <p>
            <strong>Balance outstanding:</strong>{" "}
            {formatCurrency(attendee.remaining_balance)} —{" "}
            <a href={`/admin/attendees/${attendee.id}/balance`}>
              view balance &amp; payment link
            </a>
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
        ? questionWrapper(
            q,
            undefined,
            <input
              maxlength={MAX_TEXTAREA_LENGTH}
              name={`question_${q.id}`}
              type="text"
              value={selectedTextAnswers.get(q.id) ?? ""}
            />,
          )
        : q.display_type === "select"
          ? questionWrapper(
              q,
              undefined,
              <select name={`question_${q.id}`}>
                <option value="">No answer</option>
                {q.answers
                  .filter((a) => a.active || selectedAnswerIds.includes(a.id))
                  .map((a) => (
                    <option
                      selected={selectedAnswerIds.includes(a.id) || undefined}
                      value={String(a.id)}
                    >
                      {a.text}
                    </option>
                  ))}
              </select>,
            )
          : questionFieldset(
              q,
              undefined,
              q.answers
                .filter((a) => a.active || selectedAnswerIds.includes(a.id))
                .map((a) => (
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
      <td>
        <label>
          <input checked name={name} type="radio" value="target" />{" "}
          <Raw html={renderFieldValue(targetValue, multiline)} />
        </label>
      </td>
      <td>
        {same ? (
          <span class="muted">(same)</span>
        ) : (
          <label>
            <input name={name} type="radio" value="source" />{" "}
            <Raw html={renderFieldValue(sourceValue, multiline)} />
          </label>
        )}
      </td>
    </tr>,
  );
};

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
    <div>
      <h4>{t("admin.attendees.custom_question_answers")}</h4>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("terms.question")}</th>
              <th>Keep ({targetName})</th>
              <th>Take from ({sourceName})</th>
              <th>{t("admin.attendees.th_clear")}</th>
            </tr>
          </thead>
          <tbody>
            {diff.answerItems.map((item) => {
              const name = `answer_${item.questionId}`;
              if (!item.conflict) {
                // Non-conflicting: show info only (no decision needed)
                const { answer, from } = nonConflictAnswerLabel(item);
                return (
                  <tr>
                    <th scope="row">{item.questionText}</th>
                    <td colspan="3">
                      <span class="muted">
                        {answer} ({from} — auto-kept)
                      </span>
                    </td>
                  </tr>
                );
              }
              const targetLabel = item.targetAnswerText!;
              const sourceLabel = item.sourceAnswerText!;
              return (
                <tr>
                  <th scope="row">{item.questionText}</th>
                  <td>
                    <label>
                      <input checked name={name} type="radio" value="target" />{" "}
                      {targetLabel}
                    </label>
                  </td>
                  <td>
                    <label>
                      <input name={name} type="radio" value="source" />{" "}
                      {sourceLabel}
                    </label>
                  </td>
                  <td>
                    <label>
                      <input name={name} type="radio" value="clear" /> None
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>,
  );
};

/** Render the booking decision table */
const MergeBookingsDecisionTable = ({
  diff,
}: {
  diff: AttendeeMergeDiff;
}): string => {
  const hasConflicts = hasBookingConflicts(diff.bookingItems);
  const moveableExtraCell = hasConflicts ? String(<td />) : "";

  return String(
    <div>
      <h4>{t("admin.attendees.listing_registrations")}</h4>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("terms.listing")}</th>
              <th>{t("common.date")}</th>
              <th>{t("admin.attendees.source_qty")}</th>
              <th>{t("common.status")}</th>
              {hasConflicts && <th>{t("admin.attendees.decision")}</th>}
            </tr>
          </thead>
          <tbody>
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
                  <tr>
                    <td>Listing #{item.listingId}</td>
                    <td>{dateStr}</td>
                    <td>{item.sourceBooking.quantity}</td>
                    <td>
                      <span class="muted">Will be moved</span>
                    </td>
                    <Raw html={moveableExtraCell} />
                  </tr>
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
                <tr>
                  <td>Listing #{item.listingId}</td>
                  <td>{dateStr}</td>
                  <td>{sourceQty}</td>
                  <td>
                    <strong>{conflictLabel}</strong>
                    {item.targetBooking &&
                      ` (target qty: ${targetQty}, source qty: ${sourceQty})`}
                  </td>
                  <td>
                    <label>
                      <input
                        checked
                        name={name}
                        type="radio"
                        value="keep_target"
                      />{" "}
                      Keep target
                    </label>
                    <br />
                    <label>
                      <input name={name} type="radio" value="take_source" />{" "}
                      Replace with source
                    </label>
                    <br />
                    <label>
                      <input name={name} type="radio" value="skip_source" />{" "}
                      Skip source
                    </label>
                    {moneyAtStake > 0 && (
                      <div class="merge-money-decision">
                        <p class="muted">
                          <strong>
                            {t("attendee_form.merge_discarded_payment_label")}
                          </strong>{" "}
                          (source {formatCurrency(item.sourceSaleAmount)},
                          target {formatCurrency(item.targetSaleAmount)}) — this
                          can't be undone, so choose explicitly:
                        </p>
                        <label>
                          <input
                            name={`money_${key}`}
                            type="radio"
                            value="credit"
                          />{" "}
                          Keep as the person's credit
                        </label>
                        <br />
                        <label>
                          <input
                            name={`money_${key}`}
                            type="radio"
                            value="writeoff"
                          />{" "}
                          Write it off
                        </label>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>,
  );
};

/**
 * Admin merge attendee page — search and confirm merge
 */
export const adminMergeAttendeePage = (
  target: Attendee,
  source: MergeSourceInfo | null,
  searchToken: string | null,
  session: AdminSession,
  error?: string,
  mergeDiff?: AttendeeMergeDiff,
): string =>
  String(
    <Layout title={`Merge Attendee: ${target.name}`}>
      <AdminNav active="/admin/attendees" session={session} />
      <Flash error={error} />

      <h2>{t("admin.attendees.merge_attendee")}</h2>
      <p>
        <BackButton href={`/admin/attendees/${target.id}`}>
          Back to {target.name}
        </BackButton>
      </p>

      {/* Token search form */}
      <h3>{t("admin.attendees.search_by_token")}</h3>
      <form
        action={`/admin/attendees/${target.id}/merge`}
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
            <input
              name="merge_version"
              type="hidden"
              value={mergeDiff.version}
            />

            {/* PII decisions */}
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("admin.attendees.field")}</th>
                    <th>
                      Keep (current): <strong>{target.name}</strong>
                    </th>
                    <th>
                      Take from: <strong>{source.name}</strong>
                    </th>
                  </tr>
                </thead>
                <tbody>
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
                </tbody>
              </table>
            </div>

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
    </Layout>,
  );

/**
 * Admin re-send notification confirmation page
 */
export const adminResendNotificationPage = (
  { listing, attendee }: { listing: ListingWithCount; attendee: Attendee },
  session: AdminSession,
  returnUrl?: string,
  error?: string,
): string =>
  String(
    <Layout title={`Re-send Notification: ${attendee.name}`}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/listing/${listing.id}/attendee/${attendee.id}/resend-notification`}
        buttonText={t("admin.attendees.resend_submit")}
        danger={false}
        label={t("admin.attendees.delete_label")}
        name={attendee.name}
        returnUrl={returnUrl}
      >
        <p>
          <strong>Note:</strong> This will re-send the registration notification
          for this attendee.
        </p>
        <div class="prose">
          <h2>{t("admin.attendees.details")}</h2>
          <p>
            <strong>{t("admin.attendees.name")}</strong> {attendee.name}
          </p>
          <p>
            <strong>{t("admin.attendees.email")}</strong> {attendee.email}
          </p>
          <p>
            <strong>{t("admin.attendees.quantity")}</strong> {attendee.quantity}
          </p>
          {Number.parseInt(attendee.price_paid, 10) > 0 && (
            <p>
              <strong>{t("admin.attendees.amount_paid")}</strong>{" "}
              {formatCurrency(attendee.price_paid)}
            </p>
          )}
          <p>
            <strong>Registered:</strong> {formatDatetimeShort(attendee.created)}
          </p>
          <p>{t("admin.attendees.resend_confirm", { name: attendee.name })}</p>
        </div>
      </ConfirmForm>
    </Layout>,
  );
