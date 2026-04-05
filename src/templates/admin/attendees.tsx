/**
 * Admin attendee page templates
 */

import { formatCurrency } from "#lib/currency.ts";
import { formatDateLabel } from "#lib/dates.ts";
import type { EventAttendeeRow } from "#lib/db/attendee-types.ts";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import { ConfirmForm, CsrfForm, Flash } from "#lib/forms.tsx";
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
        <p>
          To delete this attendee, type their name "{attendee.name}" into the
          box below:
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
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/event/${event.id}/attendee/${attendee.id}/refund`}
        name={attendee.name}
        label="Attendee name"
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
        <p>
          To refund this attendee, type their name "{attendee.name}" into the
          box below:
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
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/event/${event.id}/refund-all`}
        name={event.name}
        label="Event name"
        buttonText="Refund All Attendees"
      >
        <p>
          <strong>Warning:</strong> This will issue a full refund for all{" "}
          {refundableCount} attendee(s) with payments. Attendees will remain
          registered.
        </p>
        <p>
          To refund all attendees, type the event name "{event.name}" into the
          box below:
        </p>
      </ConfirmForm>
    </Layout>,
  );

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
          <span class="badge-alert">Refunded</span>
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
/** Event link data for the edit page */
type EventLinkDisplay = {
  event: EventWithCount;
  booking: EventAttendeeRow;
  date: string | null;
};

export const adminEditAttendeePage = (
  {
    attendee,
    eventLinks = [],
    allEvents,
    questions = [],
    selectedAnswerIds = [],
    availableDatesByEvent = {},
  }: {
    event: EventWithCount;
    attendee: Attendee;
    eventLinks?: EventLinkDisplay[];
    allEvents: EventWithCount[];
    questions?: QuestionWithAnswers[];
    selectedAnswerIds?: number[];
    availableDatesByEvent?: Record<number, string[]>;
  },
  session: AdminSession,
  returnUrl?: string,
  success?: string,
): string =>
  String(
    <Layout title={`Edit Attendee: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />
      <Flash success={success} />

      <h2>Edit Attendee</h2>

      <Raw html={PaymentDetails({ attendee })} />

      {/* PII Section — shared across all events */}
      <h3>Contact Information</h3>
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

        <Raw html={renderEditQuestions(questions, selectedAnswerIds)} />

        <button type="submit">Save Contact Info</button>
      </CsrfForm>

      {/* Event Links Section */}
      <h3>Event Registrations</h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Date</th>
              <th>Qty</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {eventLinks.map(({ event: evt, booking, date: linkDate }) => (
              <tr>
                <td>
                  <a href={`/admin/event/${evt.id}`}>{evt.name}</a>
                </td>
                <td>{linkDate ? formatDateLabel(linkDate) : ""}</td>
                <td>
                  <CsrfForm
                    action={`/admin/attendees/${attendee.id}/event/${evt.id}`}
                    class="inline"
                  >
                    <input
                      type="number"
                      name="quantity"
                      value={String(booking.quantity)}
                      min="1"
                      max={String(evt.max_quantity)}
                      style="width:4em"
                    />
                    <button type="submit" class="link-button">
                      Update
                    </button>
                  </CsrfForm>
                </td>
                <td>
                  {Boolean(booking.checked_in) && (
                    <span class="badge">Checked in</span>
                  )}
                  {Boolean(booking.refunded) && (
                    <span class="badge danger">Refunded</span>
                  )}
                </td>
                <td>
                  <CsrfForm
                    action={`/admin/attendees/${attendee.id}/unlink/${evt.id}`}
                    class="inline"
                  >
                    <button type="submit" class="link-button danger">
                      Remove
                    </button>
                  </CsrfForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add Event Link Section */}
      <h3>Add to Event</h3>
      <CsrfForm action={`/admin/attendees/${attendee.id}/link`}>
        <label for="add_event_id">
          Event
          <select id="add_event_id" name="event_id" required>
            <option value="">Select event...</option>
            {allEvents
              .filter((e) => e.active)
              .map((e) => (
                <option value={String(e.id)} data-event-type={e.event_type}>
                  {e.name}
                </option>
              ))}
          </select>
        </label>

        <label for="add_quantity">
          Quantity
          <input
            type="number"
            id="add_quantity"
            name="quantity"
            value="1"
            min="1"
            required
          />
        </label>

        <label for="add_date" class="daily-date-field" style="display:none">
          Date
          <select id="add_date" name="date">
            <option value="">Select date...</option>
          </select>
        </label>

        <button type="submit">Add to Event</button>
      </CsrfForm>

      {/* Available dates JSON for client-side date picker filtering (read by admin.ts) */}
      <script type="application/json" id="available-dates-data">
        <Raw html={JSON.stringify(availableDatesByEvent)} />
      </script>
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
        <p>
          To re-send the notification, type their name "{attendee.name}" into
          the box below:
        </p>
      </ConfirmForm>
    </Layout>,
  );
