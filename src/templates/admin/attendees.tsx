/**
 * Admin attendee page templates
 */

import { map, pipe, unique } from "#fp";
import { formatCurrency } from "#lib/currency.ts";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import { CsrfForm } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { t } from "#i18n";
import { AdminNav } from "#templates/admin/nav.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/**
 * Admin delete attendee confirmation page
 */
export const adminDeleteAttendeePage = (
  { event, attendee }: { event: EventWithCount; attendee: Attendee },
  session: AdminSession,
  error?: string,
  returnUrl?: string,
): string =>
  String(
    <Layout title={`Delete Attendee: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />
      {error && <div class="error">{error}</div>}

      <article>
        <aside>
          <p>
            {t("admin.attendees.delete_warning")}
          </p>
        </aside>
      </article>

      <article>
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
          <strong>{t("admin.attendees.registered")}</strong>{" "}
          {new Date(attendee.created).toLocaleString()}
        </p>
      </article>

      <p>
        {t("admin.attendees.delete_confirm", { name: attendee.name })}
      </p>

      <CsrfForm
        action={`/admin/event/${event.id}/attendee/${attendee.id}/delete`}
      >
        {returnUrl && (
          <input type="hidden" name="return_url" value={returnUrl} />
        )}
        <label for="confirm_name">{t("admin.attendees.delete_label")}</label>
        <input
          type="text"
          id="confirm_name"
          name="confirm_name"
          placeholder={attendee.name}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          {t("admin.attendees.delete_submit")}
        </button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin refund attendee confirmation page
 */
export const adminRefundAttendeePage = (
  { event, attendee }: { event: EventWithCount; attendee: Attendee },
  session: AdminSession,
  error?: string,
  returnUrl?: string,
): string =>
  String(
    <Layout title={`Refund Attendee: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />
      {error && <div class="error">{error}</div>}

      <article>
        <aside>
          <p>
            {t("admin.attendees.refund_warning")}
          </p>
        </aside>
      </article>

      <article>
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
            <strong>{t("admin.attendees.amount_paid")}</strong> {formatCurrency(attendee.price_paid)}
          </p>
        )}
        <p>
          <strong>{t("admin.attendees.registered")}</strong>{" "}
          {new Date(attendee.created).toLocaleString()}
        </p>
      </article>

      <p>
        {t("admin.attendees.refund_confirm", { name: attendee.name })}
      </p>

      <CsrfForm
        action={`/admin/event/${event.id}/attendee/${attendee.id}/refund`}
      >
        {returnUrl && (
          <input type="hidden" name="return_url" value={returnUrl} />
        )}
        <label for="confirm_name">{t("admin.attendees.delete_label")}</label>
        <input
          type="text"
          id="confirm_name"
          name="confirm_name"
          placeholder={attendee.name}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          {t("admin.attendees.refund_submit")}
        </button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin refund all attendees confirmation page
 */
export const adminRefundAllAttendeesPage = (
  event: EventWithCount,
  refundableCount: number,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Refund All: ${event.name}`}>
      <AdminNav session={session} active="/admin/" />
      {error && <div class="error">{error}</div>}

      <article>
        <aside>
          <p>
            {t("admin.attendees.refund_all_warning", { count: refundableCount })}
          </p>
        </aside>
      </article>

      <p>
        {t("admin.attendees.refund_all_confirm", { name: event.name })}
      </p>

      <CsrfForm action={`/admin/event/${event.id}/refund-all`}>
        <label for="confirm_name">{t("admin.attendees.refund_all_label")}</label>
        <input
          type="text"
          id="confirm_name"
          name="confirm_name"
          placeholder={event.name}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          {t("admin.attendees.refund_all_submit")}
        </button>
      </CsrfForm>
    </Layout>,
  );

/** Render event selector for edit attendee page */
const renderEventSelector = (
  currentEventId: number,
  allEvents: EventWithCount[],
): string => {
  // Get unique event IDs (current event + active events, uniquified)
  const eventIds = pipe(
    map((e: EventWithCount) => e.id),
    unique,
  )([{ id: currentEventId } as EventWithCount, ...allEvents]);

  // Build options HTML
  const options = eventIds
    .map((id) => {
      const event = allEvents.find((e) => e.id === id)!;
      const selected = id === currentEventId ? " selected" : "";
      return `<option value="${id}"${selected}>${event.name}${!event.active ? " (inactive)" : ""}</option>`;
    })
    .join("");

  return `<label for="event_id">${escapeHtml(t("admin.attendees.edit.event"))}<select id="event_id" name="event_id" required>${options}</select></label>`;
};

/** Render payment details section (read-only) */
const PaymentDetails = ({ attendee }: { attendee: Attendee }): string => {
  if (!attendee.payment_id) return "";
  const pricePaid = Number.parseInt(attendee.price_paid, 10);
  const isRefunded = attendee.refunded;

  return String(
    <article>
      <h3>{t("admin.attendees.payment_details")}</h3>
      <p>
        <strong>{t("admin.attendees.payment_id")}</strong> {attendee.payment_id}
      </p>
      {pricePaid > 0 && (
        <p>
          <strong>{t("admin.attendees.amount_paid")}</strong> {formatCurrency(attendee.price_paid)}
        </p>
      )}
      <p>
        <strong>{t("admin.attendees.refund_status")}</strong>{" "}
        {isRefunded ? (
          <span class="badge-refunded">{t("admin.attendees.refunded")}</span>
        ) : (
          t("admin.attendees.not_refunded")
        )}
      </p>
      <CsrfForm
        action={`/admin/attendees/${attendee.id}/refresh-payment`}
        class="inline"
      >
        <button type="submit">{t("admin.attendees.refresh_payment")}</button>
      </CsrfForm>
    </article>,
  );
};

/** Render custom question fields with pre-selected answers for admin edit */
const renderEditQuestions = (
  questions: QuestionWithAnswers[],
  selectedAnswerIds: number[],
): string => {
  if (questions.length === 0) return "";
  return questions
    .map((q) => {
      const options = q.answers
        .map((a) => {
          const checked = selectedAnswerIds.includes(a.id) ? " checked" : "";
          return `<label><input type="radio" name="question_${q.id}" value="${a.id}"${checked}> ${escapeHtml(a.text)}</label>`;
        })
        .join("");
      return `<fieldset class="custom-question"><legend>${escapeHtml(q.text)}</legend>${options}</fieldset>`;
    })
    .join("");
};

/**
 * Admin edit attendee page
 */
export const adminEditAttendeePage = (
  {
    event,
    attendee,
    allEvents,
    questions = [],
    selectedAnswerIds = [],
  }: {
    event: EventWithCount;
    attendee: Attendee;
    allEvents: EventWithCount[];
    questions?: QuestionWithAnswers[];
    selectedAnswerIds?: number[];
  },
  session: AdminSession,
  error?: string,
  returnUrl?: string,
  success?: string,
): string =>
  String(
    <Layout title={`Edit Attendee: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />
      {error && <div class="error">{error}</div>}
      {success && <div class="success">{success}</div>}

      <h2>{t("admin.attendees.edit_attendee")}</h2>

      <Raw html={PaymentDetails({ attendee })} />

      <CsrfForm action={`/admin/attendees/${attendee.id}`}>
        {returnUrl && (
          <input type="hidden" name="return_url" value={returnUrl} />
        )}

        <label for="name">
          {t("admin.attendees.edit.name")}
          <input
            type="text"
            id="name"
            name="name"
            value={attendee.name}
            required
            autofocus
          />
        </label>

        <label for="email">
          {t("admin.attendees.edit.email")}
          <input
            type="email"
            id="email"
            name="email"
            value={attendee.email || ""}
          />
        </label>

        <label for="phone">
          {t("admin.attendees.edit.phone")}
          <input
            type="text"
            id="phone"
            name="phone"
            value={attendee.phone || ""}
          />
        </label>

        <label for="address">
          {t("admin.attendees.edit.address")}
          <textarea id="address" name="address" rows={3}>
            {attendee.address || ""}
          </textarea>
        </label>

        <label for="special_instructions">
          {t("admin.attendees.edit.special_instructions")}
          <textarea
            id="special_instructions"
            name="special_instructions"
            rows={3}
          >
            {attendee.special_instructions || ""}
          </textarea>
        </label>

        <label for="quantity">
          {t("admin.attendees.edit.quantity")}
          <input
            type="number"
            id="quantity"
            name="quantity"
            value={String(attendee.quantity)}
            min="1"
            max={String(event.max_quantity)}
            required
          />
        </label>

        <Raw html={renderEventSelector(event.id, allEvents)} />

        <Raw html={renderEditQuestions(questions, selectedAnswerIds)} />

        <button type="submit">{t("admin.attendees.edit.submit")}</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin re-send notification confirmation page
 */
export const adminResendNotificationPage = (
  { event, attendee }: { event: EventWithCount; attendee: Attendee },
  session: AdminSession,
  error?: string,
  returnUrl?: string,
): string =>
  String(
    <Layout title={`Re-send Notification: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />
      {error && <div class="error">{error}</div>}

      <article>
        <aside>
          <p>
            {t("admin.attendees.resend_note")}
          </p>
        </aside>
      </article>

      <article>
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
            <strong>{t("admin.attendees.amount_paid")}</strong> {formatCurrency(attendee.price_paid)}
          </p>
        )}
        <p>
          <strong>{t("admin.attendees.registered")}</strong>{" "}
          {new Date(attendee.created).toLocaleString()}
        </p>
      </article>

      <p>
        {t("admin.attendees.resend_confirm", { name: attendee.name })}
      </p>

      <CsrfForm
        action={`/admin/event/${event.id}/attendee/${attendee.id}/resend-notification`}
      >
        {returnUrl && (
          <input type="hidden" name="return_url" value={returnUrl} />
        )}
        <label for="confirm_name">{t("admin.attendees.delete_label")}</label>
        <input
          type="text"
          id="confirm_name"
          name="confirm_name"
          placeholder={attendee.name}
          autocomplete="off"
          required
        />
        <button type="submit">{t("admin.attendees.resend_submit")}</button>
      </CsrfForm>
    </Layout>,
  );
