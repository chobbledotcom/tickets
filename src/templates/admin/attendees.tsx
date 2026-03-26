/**
 * Admin attendee page templates
 */

import { map, pipe, unique } from "#fp";
import { formatCurrency } from "#lib/currency.ts";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import { ConfirmForm, CsrfForm } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/**
 * Admin delete attendee confirmation page
 */
export const adminDeleteAttendeePage = (
  { event, attendee }: { event: EventWithCount; attendee: Attendee },
  session: AdminSession,
  returnUrl?: string,
): string =>
  String(
    <Layout title={`Delete Attendee: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />

      <ConfirmForm
        action={`/admin/event/${event.id}/attendee/${attendee.id}/delete`}
        name={attendee.name}
        label="Attendee name"
        prompt="To delete this attendee, you must type their name"
        buttonText="Delete Attendee"
        returnUrl={returnUrl}
      >
        <p>
          <strong>Warning:</strong> This will permanently remove this attendee
          from the event and delete any associated payment records.
        </p>
        <h2>Attendee Details</h2>
        <p>
          <strong>Name:</strong> {attendee.name}
        </p>
        <p>
          <strong>Email:</strong> {attendee.email}
        </p>
        <p>
          <strong>Quantity:</strong> {attendee.quantity}
        </p>
        <p>
          <strong>Registered:</strong>{" "}
          {new Date(attendee.created).toLocaleString()}
        </p>
      </ConfirmForm>
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

      <ConfirmForm
        action={`/admin/event/${event.id}/attendee/${attendee.id}/refund`}
        name={attendee.name}
        label="Attendee name"
        prompt="To refund this attendee, you must type their name"
        buttonText="Refund Attendee"
        returnUrl={returnUrl}
      >
        <p>
          <strong>Warning:</strong> This will issue a full refund for this
          attendee's payment. The attendee will remain registered.
        </p>
        <h2>Attendee Details</h2>
        <p>
          <strong>Name:</strong> {attendee.name}
        </p>
        <p>
          <strong>Email:</strong> {attendee.email}
        </p>
        <p>
          <strong>Quantity:</strong> {attendee.quantity}
        </p>
        {Number.parseInt(attendee.price_paid, 10) > 0 && (
          <p>
            <strong>Amount Paid:</strong> {formatCurrency(attendee.price_paid)}
          </p>
        )}
        <p>
          <strong>Registered:</strong>{" "}
          {new Date(attendee.created).toLocaleString()}
        </p>
      </ConfirmForm>
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

      <ConfirmForm
        action={`/admin/event/${event.id}/refund-all`}
        name={event.name}
        label="Event name"
        prompt="To refund all attendees, you must type the event name"
        buttonText="Refund All Attendees"
      >
        <p>
          <strong>Warning:</strong> This will issue a full refund for all{" "}
          {refundableCount} attendee(s) with payments. Attendees will remain
          registered.
        </p>
      </ConfirmForm>
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

  return `<label for="event_id">Event<select id="event_id" name="event_id" required>${options}</select></label>`;
};

/** Render payment details section (read-only) */
const PaymentDetails = ({ attendee }: { attendee: Attendee }): string => {
  if (!attendee.payment_id) return "";
  const pricePaid = Number.parseInt(attendee.price_paid, 10);
  const isRefunded = attendee.refunded;

  return String(
    <article>
      <h3>Payment Details</h3>
      <p>
        <strong>Payment ID:</strong> {attendee.payment_id}
      </p>
      {pricePaid > 0 && (
        <p>
          <strong>Amount Paid:</strong> {formatCurrency(attendee.price_paid)}
        </p>
      )}
      <p>
        <strong>Refund Status:</strong>{" "}
        {isRefunded ? (
          <span class="badge-refunded">Refunded</span>
        ) : (
          "Not refunded"
        )}
      </p>
      <CsrfForm
        action={`/admin/attendees/${attendee.id}/refresh-payment`}
        class="inline"
      >
        <button type="submit">Refresh payment status</button>
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
  returnUrl?: string,
  success?: string,
): string =>
  String(
    <Layout title={`Edit Attendee: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />
      {success && <div class="success">{success}</div>}

      <h2>Edit Attendee</h2>

      <Raw html={PaymentDetails({ attendee })} />

      <CsrfForm action={`/admin/attendees/${attendee.id}`}>
        {returnUrl && (
          <input type="hidden" name="return_url" value={returnUrl} />
        )}

        <label for="name">
          Name
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
          Email
          <input
            type="email"
            id="email"
            name="email"
            value={attendee.email || ""}
          />
        </label>

        <label for="phone">
          Phone
          <input
            type="text"
            id="phone"
            name="phone"
            value={attendee.phone || ""}
            pattern="[+\d][\d\s\-()]{5,}"
            title="Phone number (digits, spaces, hyphens, parentheses, optional leading +)"
          />
        </label>

        <label for="address">
          Address
          <textarea id="address" name="address" rows={3} maxlength={250}>
            {attendee.address || ""}
          </textarea>
        </label>

        <label for="special_instructions">
          Special Instructions
          <textarea
            id="special_instructions"
            name="special_instructions"
            rows={3}
            maxlength={250}
          >
            {attendee.special_instructions || ""}
          </textarea>
        </label>

        <label for="quantity">
          Quantity
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

        <button type="submit">Save Changes</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin re-send notification confirmation page
 */
export const adminResendNotificationPage = (
  { event, attendee }: { event: EventWithCount; attendee: Attendee },
  session: AdminSession,
  returnUrl?: string,
): string =>
  String(
    <Layout title={`Re-send Notification: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />

      <ConfirmForm
        action={`/admin/event/${event.id}/attendee/${attendee.id}/resend-notification`}
        name={attendee.name}
        label="Attendee name"
        prompt="To re-send the notification, you must type their name"
        buttonText="Re-send Notification"
        danger={false}
        returnUrl={returnUrl}
      >
        <p>
          <strong>Note:</strong> This will re-send the registration notification
          for this attendee.
        </p>
        <h2>Attendee Details</h2>
        <p>
          <strong>Name:</strong> {attendee.name}
        </p>
        <p>
          <strong>Email:</strong> {attendee.email}
        </p>
        <p>
          <strong>Quantity:</strong> {attendee.quantity}
        </p>
        {Number.parseInt(attendee.price_paid, 10) > 0 && (
          <p>
            <strong>Amount Paid:</strong> {formatCurrency(attendee.price_paid)}
          </p>
        )}
        <p>
          <strong>Registered:</strong>{" "}
          {new Date(attendee.created).toLocaleString()}
        </p>
      </ConfirmForm>
    </Layout>,
  );
