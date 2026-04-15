/**
 * Admin attendee page templates
 */

import { formatCurrency } from "#lib/currency.ts";
import {
  formatDateLabel,
  formatDateRangeLabel,
  formatDatetimeShort,
} from "#lib/dates.ts";
import type { EventAttendeeRow } from "#lib/db/attendee-types.ts";
import type { QuestionWithAnswers } from "#lib/db/questions.ts";
import { ConfirmForm, CsrfForm, Flash } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import {
  bookingConflictLabel,
  bookingKey,
  hasBookingConflicts,
  nonConflictAnswerLabel,
} from "#lib/merge/attendee-merge.ts";
import type { AttendeeMergeDiff } from "#lib/merge/attendee-merge-types.ts";
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
  error?: string,
): string =>
  String(
    <Layout title={`Delete Attendee: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />
      <Flash error={error} />

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
          <strong>Registered:</strong> {formatDatetimeShort(attendee.created)}
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
          <strong>Registered:</strong> {formatDatetimeShort(attendee.created)}
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
  error?: string,
): string =>
  String(
    <Layout title={`Edit Attendee: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />
      <Flash success={success} error={error} />

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
              <th style="width:1%"></th>
            </tr>
          </thead>
          <tbody>
            {eventLinks.map(({ event: evt, booking, date: linkDate }) => (
              <tr>
                <td>
                  <a href={`/admin/event/${evt.id}`}>{evt.name}</a>
                </td>
                <td>
                  {linkDate
                    ? formatDateRangeLabel(booking.start_at, booking.end_at) ||
                      formatDateLabel(linkDate)
                    : ""}
                </td>
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
                <td style="white-space:nowrap">
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

      {/* Merge Section */}
      <h3>Merge Attendee</h3>
      <p>
        Search for another attendee by their ticket token and merge their event
        registrations into this attendee.
      </p>
      <form
        action={`/admin/attendees/${attendee.id}/merge`}
        method="get"
        class="inline-row"
      >
        <label for="merge_token">
          Ticket token
          <input
            type="text"
            id="merge_token"
            name="token"
            placeholder="Enter ticket token…"
            required
          />
        </label>
        <button type="submit">Search</button>
      </form>
    </Layout>,
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
  bookings: EventAttendeeRow[];
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
          <input type="radio" name={name} value="target" checked />{" "}
          <Raw html={renderFieldValue(targetValue, multiline)} />
        </label>
      </td>
      <td>
        {same ? (
          <span class="muted">(same)</span>
        ) : (
          <label>
            <input type="radio" name={name} value="source" />{" "}
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
      <h4>Custom Question Answers</h4>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Keep ({targetName})</th>
              <th>Take from ({sourceName})</th>
              <th>Clear</th>
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
                      <input type="radio" name={name} value="target" checked />{" "}
                      {targetLabel}
                    </label>
                  </td>
                  <td>
                    <label>
                      <input type="radio" name={name} value="source" />{" "}
                      {sourceLabel}
                    </label>
                  </td>
                  <td>
                    <label>
                      <input type="radio" name={name} value="clear" /> None
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
      <h4>Event Registrations</h4>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Date</th>
              <th>Source (qty)</th>
              <th>Status</th>
              {hasConflicts && <th>Decision</th>}
            </tr>
          </thead>
          <tbody>
            {diff.bookingItems.map((item) => {
              const key = bookingKey(item.eventId, item.startAt);
              const name = `booking_${key}`;
              const dateStr = item.startAt ? item.startAt.slice(0, 10) : "—";

              if (item.conflictClass === "moveable") {
                return (
                  <tr>
                    <td>Event #{item.eventId}</td>
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

              return (
                <tr>
                  <td>Event #{item.eventId}</td>
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
                        type="radio"
                        name={name}
                        value="keep_target"
                        checked
                      />{" "}
                      Keep target
                    </label>
                    <br />
                    <label>
                      <input type="radio" name={name} value="take_source" />{" "}
                      Replace with source
                    </label>
                    <br />
                    <label>
                      <input type="radio" name={name} value="skip_source" />{" "}
                      Skip source
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
      <AdminNav session={session} active="/admin/" />
      <Flash error={error} />

      <h2>Merge Attendee</h2>
      <p>
        <a href={`/admin/attendees/${target.id}`}>← Back to {target.name}</a>
      </p>

      {/* Token search form */}
      <h3>Search by Ticket Token</h3>
      <form
        action={`/admin/attendees/${target.id}/merge`}
        method="get"
        class="inline-row"
      >
        <label for="token">
          Ticket token to merge from
          <input
            type="text"
            id="token"
            name="token"
            value={searchToken || ""}
            placeholder="Enter ticket token…"
            required
            autofocus={!source}
          />
        </label>
        <button type="submit">Search</button>
      </form>

      {source && mergeDiff && (
        <div>
          <h3>Merge Preview</h3>
          <p>
            Choose which value to keep for each field. Resolve any conflicts
            below. The source attendee will then be deleted.
          </p>

          <CsrfForm action={`/admin/attendees/${target.id}/merge`}>
            <input
              type="hidden"
              name="source_token"
              value={source.ticket_token}
            />
            <input
              type="hidden"
              name="merge_version"
              value={mergeDiff.version}
            />

            {/* PII decisions */}
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
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
            <button type="submit" class="danger">
              Merge and Delete Source Attendee
            </button>
          </CsrfForm>
        </div>
      )}
    </Layout>,
  );

/**
 * Admin re-send notification confirmation page
 */
export const adminResendNotificationPage = (
  { event, attendee }: { event: EventWithCount; attendee: Attendee },
  session: AdminSession,
  returnUrl?: string,
  error?: string,
): string =>
  String(
    <Layout title={`Re-send Notification: ${attendee.name}`}>
      <AdminNav session={session} active="/admin/" />
      <Flash error={error} />

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
          <strong>Registered:</strong> {formatDatetimeShort(attendee.created)}
        </p>
        <p>
          To re-send the notification, type their name "{attendee.name}" into
          the box below:
        </p>
      </ConfirmForm>
    </Layout>,
  );
