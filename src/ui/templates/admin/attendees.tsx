/**
 * Admin attendee page templates
 */

import { formatCurrency } from "#shared/currency.ts";
import { formatDateRangeLabel, formatDatetimeShort } from "#shared/dates.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import { ConfirmForm, CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  bookingConflictLabel,
  bookingKey,
  hasBookingConflicts,
  nonConflictAnswerLabel,
} from "#shared/merge/attendee-merge.ts";
import type { AttendeeMergeDiff } from "#shared/merge/attendee-merge-types.ts";
import type {
  AdminSession,
  Attendee,
  ListingWithCount,
} from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
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
        buttonText="Delete Attendee"
        label="Attendee name"
        name={attendee.name}
        returnUrl={returnUrl}
      >
        <p>
          <strong>Warning:</strong> This will permanently remove this attendee
          from the listing and delete any associated payment records.
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
        buttonText="Refund Attendee"
        label="Attendee name"
        name={attendee.name}
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
        buttonText="Refund All Attendees"
        label="Listing name"
        name={listing.name}
      >
        <p>
          <strong>Warning:</strong> This will issue a full refund for all{" "}
          {refundableCount} attendee(s) with payments. Attendees will remain
          registered.
        </p>
        <p>
          To refund all attendees, type the listing name "{listing.name}" into
          the box below:
        </p>
      </ConfirmForm>
    </Layout>,
  );

/**
 * Admin refund attendee confirmation page
 */

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
      <h4>Listing Registrations</h4>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Listing</th>
              <th>Date</th>
              <th>Source (qty)</th>
              <th>Status</th>
              {hasConflicts && <th>Decision</th>}
            </tr>
          </thead>
          <tbody>
            {diff.bookingItems.map((item) => {
              const key = bookingKey(item.listingId, item.startAt);
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
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <h2>Merge Attendee</h2>
      <p>
        <a href={`/admin/attendees/${target.id}`}>← Back to {target.name}</a>
      </p>

      {/* Token search form */}
      <h3>Search by Ticket Token</h3>
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
            placeholder="Enter ticket token…"
            required
            type="text"
            value={searchToken || ""}
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
            <button class="danger" type="submit">
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
        buttonText="Re-send Notification"
        danger={false}
        label="Attendee name"
        name={attendee.name}
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
