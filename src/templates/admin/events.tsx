/**
 * Admin event page templates - detail, edit, delete
 */

import { filter, map, pipe, reduce } from "#fp";
import { getTz } from "#lib/config.ts";
import { formatCurrency, toMajorUnits } from "#lib/currency.ts";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import { buildEmbedSnippets } from "#lib/embed.ts";
import type { Field } from "#lib/forms.tsx";
import {
  CsrfForm,
  type FieldValues,
  renderError,
  renderField,
  renderFields,
  renderSuccess,
} from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { isStorageEnabled } from "#lib/storage.ts";
import { utcToLocalInput } from "#lib/timezone.ts";
import {
  type AdminSession,
  type Attendee,
  type EventWithCount,
  type Group,
  isPaidEvent,
} from "#lib/types.ts";
import { formatCountdown } from "#routes/utils.ts";
import { EventGroupSelect } from "#templates/admin/group-select.tsx";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";
import {
  AttendeeTable,
  type AttendeeTableRow,
} from "#templates/attendee-table.tsx";
import {
  attachmentField,
  eventFields,
  getAddAttendeeFields,
  imageField,
  slugField,
} from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { renderEventImage } from "#templates/public.tsx";

/** Date option for the date filter dropdown */
export type DateOption = { value: string; label: string };

/** Attendee filter type */
export type AttendeeFilter = "all" | "in" | "out";

/** Re-export formatAddressInline from shared module for backwards compatibility */
export { formatAddressInline } from "#templates/attendee-table.tsx";

/** Calculate total revenue in cents from attendees */
export const calculateTotalRevenue = (attendees: Attendee[]): number =>
  reduce(
    (sum: number, a: Attendee) => sum + Number.parseInt(a.price_paid, 10),
    0,
  )(attendees);

/** Count how many people are checked in (summing quantity per registration) */
export const countCheckedIn = (attendees: Attendee[]): number =>
  pipe(
    filter((a: Attendee) => a.checked_in),
    reduce((sum: number, a: Attendee) => sum + a.quantity, 0),
  )(attendees);

/** Count how many attendee rows are checked in (ignoring quantity) */
export const countCheckedInRows = (attendees: Attendee[]): number =>
  filter((a: Attendee) => a.checked_in)(attendees).length;

/** Check if event is within 10% of capacity */
export const nearCapacity = (event: EventWithCount): boolean =>
  event.attendee_count >= event.max_attendees * 0.9;

/**
 * Check if an attendee has an incomplete/failed payment.
 * True when the event is paid, the attendee has no payment reference,
 * but was charged a non-zero price (distinguishing from admin-added attendees
 * who have price_paid=0).
 */
export const isIncompletePayment = (
  attendee: Attendee,
  hasPaidEvent: boolean,
): boolean =>
  hasPaidEvent &&
  !attendee.payment_id &&
  Number.parseInt(attendee.price_paid, 10) > 0;

/** Sum the quantity field across a list of attendees */
export const sumQuantity = reduce(
  (sum: number, a: Attendee) => sum + a.quantity,
  0,
);

/** Concatenate strings (curried reducer for use in pipe) */
const joinStrings = reduce((acc: string, s: string) => acc + s, "");

/** Render a single row in the Failed Payments table */
const FailedPaymentRow = ({
  attendee,
  eventId,
}: {
  attendee: Attendee;
  eventId: number;
}): string =>
  String(
    <tr>
      <td>{attendee.name}</td>
      <td>{attendee.quantity}</td>
      <td>{new Date(attendee.created).toLocaleString()}</td>
      <td>
        <CsrfForm
          action={`/admin/event/${eventId}/attendee/${attendee.id}/delete-incomplete`}
          class="inline"
        >
          <button type="submit" class="link-button danger">
            Delete
          </button>
        </CsrfForm>
      </td>
    </tr>,
  );

/** Render a table of attendees with failed/incomplete payments */
const FailedPaymentsTable = ({
  attendees,
  eventId,
}: {
  attendees: Attendee[];
  eventId: number;
}): string =>
  String(
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Qty</th>
          <th>Registered</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <Raw
          html={pipe(
            map((a: Attendee) => FailedPaymentRow({ attendee: a, eventId })),
            joinStrings,
          )(attendees)}
        />
      </tbody>
    </table>,
  );

/** Check-in message to display after toggling */
export type CheckinMessage = { name: string; status: string } | null;

/** Filter attendees by check-in status */
const filterAttendees = (
  attendees: Attendee[],
  activeFilter: AttendeeFilter,
): Attendee[] => {
  if (activeFilter === "in")
    return filter((a: Attendee) => a.checked_in)(attendees);
  if (activeFilter === "out")
    return filter((a: Attendee) => !a.checked_in)(attendees);
  return attendees;
};

/** Render a filter link, bold if active */
const FilterLink = ({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}): string =>
  active
    ? String(<strong>{label}</strong>)
    : String(<a href={href}>{label}</a>);

/** Build the path suffix for a checkin filter (preserves date query) */
const filterSuffix = (activeFilter: AttendeeFilter): string =>
  activeFilter === "all" ? "" : `/${activeFilter}`;

/** Date selector dropdown for daily events */
const DateSelector = ({
  basePath,
  activeFilter,
  dateFilter,
  dates,
}: {
  basePath: string;
  activeFilter: AttendeeFilter;
  dateFilter: string | null;
  dates: DateOption[];
}): string => {
  const suffix = filterSuffix(activeFilter);
  const options = [
    `<option value="${basePath}${suffix}#attendees"${!dateFilter ? " selected" : ""}>All dates</option>`,
    ...dates.map(
      (d) =>
        `<option value="${basePath}${suffix}?date=${d.value}#attendees"${dateFilter === d.value ? " selected" : ""}>${d.label}</option>`,
    ),
  ].join("");
  return `<select data-nav-select>${options}</select>`;
};

/** Options for rendering the admin event detail page */
export type AdminEventPageOptions = {
  event: EventWithCount;
  attendees: Attendee[];
  allowedDomain: string;
  session: AdminSession;
  checkinMessage?: CheckinMessage;
  activeFilter?: AttendeeFilter;
  dateFilter?: string | null;
  availableDates?: DateOption[];
  errorMessage?: string | null;
  phonePrefix?: string;
  successMessage?: string | null;
};

export const adminEventPage = ({
  event,
  attendees,
  allowedDomain,
  session,
  checkinMessage,
  activeFilter = "all",
  dateFilter = null,
  availableDates = [],
  errorMessage = null,
  phonePrefix,
  successMessage = null,
}: AdminEventPageOptions): string => {
  const ticketUrl = `https://${allowedDomain}/ticket/${event.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } =
    buildEmbedSnippets(ticketUrl);
  const isDaily = event.event_type === "daily";
  const hasPaidEvent = isPaidEvent(event);

  // Separate attendees with incomplete/failed payments from the main list
  const incompleteAttendees = hasPaidEvent
    ? filter((a: Attendee) => isIncompletePayment(a, true))(attendees)
    : [];
  const completeAttendees = hasPaidEvent
    ? filter((a: Attendee) => !isIncompletePayment(a, true))(attendees)
    : attendees;
  const incompleteQuantitySum = sumQuantity(incompleteAttendees);
  const adjustedCount = event.attendee_count - incompleteQuantitySum;
  const completeQuantitySum = sumQuantity(completeAttendees);

  const hasMultiQuantity = completeQuantitySum !== completeAttendees.length;
  const filteredAttendees = filterAttendees(completeAttendees, activeFilter);
  const ticketsCheckedIn = countCheckedIn(completeAttendees);
  const ticketsCheckedInRemaining = completeQuantitySum - ticketsCheckedIn;
  const attendeesCheckedIn = countCheckedInRows(completeAttendees);
  const attendeesCheckedInRemaining =
    completeAttendees.length - attendeesCheckedIn;
  const basePath = `/admin/event/${event.id}`;
  const dateQs = dateFilter ? `?date=${dateFilter}` : "";
  const suffix = filterSuffix(activeFilter);
  const returnUrl = `${basePath}${suffix}${dateQs}#attendees`;
  const tableRows: AttendeeTableRow[] = pipe(
    map(
      (a: Attendee): AttendeeTableRow => ({
        attendee: a,
        eventId: event.id,
        eventName: event.name,
      }),
    ),
  )(filteredAttendees);

  const checkedInLabel = checkinMessage?.status === "in" ? "in" : "out";
  const checkedInClass =
    checkinMessage?.status === "in"
      ? "checkin-message-in"
      : "checkin-message-out";

  return String(
    <Layout title={`Event: ${event.name}`}>
      <AdminNav session={session} active="/admin/" />

      <h1>{event.name}</h1>
      <nav>
        <ul>
          <li>
            <a href={`/admin/event/${event.id}/edit`}>Edit</a>
          </li>
          <li>
            <a href={`/admin/event/${event.id}/duplicate`}>Duplicate</a>
          </li>
          <li>
            <a href={`/admin/event/${event.id}/log`}>Log</a>
          </li>
          <li>
            <a href={`/admin/event/${event.id}/scanner`}>Scanner</a>
          </li>
          <li>
            <a
              href={`/admin/event/${event.id}/export${dateFilter ? `?date=${dateFilter}` : ""}`}
            >
              Export CSV
            </a>
          </li>
          {hasPaidEvent && (
            <li>
              <a href={`/admin/event/${event.id}/refund-all`} class="danger">
                Refund All
              </a>
            </li>
          )}
          {event.active ? (
            <li>
              <a href={`/admin/event/${event.id}/deactivate`} class="danger">
                Deactivate
              </a>
            </li>
          ) : (
            <li>
              <a href={`/admin/event/${event.id}/reactivate`}>Reactivate</a>
            </li>
          )}
          <li>
            <a href={`/admin/event/${event.id}/delete`} class="danger">
              Delete
            </a>
          </li>
        </ul>
      </nav>

      <Raw html={renderSuccess(successMessage ?? undefined)} />

      {!event.active && (
        <div class="error">This event is deactivated and cannot be booked</div>
      )}

      {errorMessage && <p class="error">{errorMessage}</p>}

      <article>
        <h2>Event Details</h2>
        <div class="table-scroll">
          <table class="event-details-table">
            <tbody>
              {event.date && (
                <tr>
                  <th>Event Date</th>
                  <td>
                    <span>
                      <a
                        href={`/admin/calendar?date=${event.date.slice(0, 10)}`}
                      >
                        {formatDatetimeLabel(event.date)}
                      </a>{" "}
                      <small>
                        <em>({formatCountdown(event.date)})</em>
                      </small>
                    </span>
                  </td>
                </tr>
              )}
              {event.location && (
                <tr>
                  <th>Location</th>
                  <td>{event.location}</td>
                </tr>
              )}
              <tr>
                <th>Event Type</th>
                <td>{event.event_type === "daily" ? "Daily" : "Standard"}</td>
              </tr>
              {event.non_transferable && (
                <tr>
                  <th>Non-Transferable</th>
                  <td>Yes &mdash; ID verification required at entry</td>
                </tr>
              )}
              {event.hidden && (
                <tr>
                  <th>Hidden</th>
                  <td>Yes &mdash; not shown in public events list</td>
                </tr>
              )}
              {event.event_type === "daily" && (
                <tr>
                  <th>Bookable Days</th>
                  <td>{formatBookableDays(event.bookable_days)}</td>
                </tr>
              )}
              {event.event_type === "daily" && (
                <tr>
                  <th>Booking Window</th>
                  <td>
                    {event.minimum_days_before} to{" "}
                    {event.maximum_days_after === 0
                      ? "unlimited"
                      : event.maximum_days_after}{" "}
                    days from today
                  </td>
                </tr>
              )}
              <tr>
                <th>
                  Attendees
                  {isDaily
                    ? dateFilter
                      ? ` (${formatDateLabel(dateFilter)})`
                      : " (total)"
                    : ""}
                </th>
                <td>
                  {isDaily && dateFilter ? (
                    <span
                      class={
                        completeQuantitySum >= event.max_attendees
                          ? "danger-text"
                          : ""
                      }
                    >
                      {completeQuantitySum} / {event.max_attendees} &mdash;{" "}
                      {event.max_attendees - completeQuantitySum} remain
                    </span>
                  ) : (
                    <span
                      class={
                        adjustedCount >= event.max_attendees * 0.9
                          ? "danger-text"
                          : ""
                      }
                    >
                      {adjustedCount}
                      {!isDaily && (
                        <>
                          {" "}
                          / {event.max_attendees} &mdash;{" "}
                          {event.max_attendees - adjustedCount} remain
                        </>
                      )}
                    </span>
                  )}
                  {isDaily && !dateFilter && (
                    <>
                      {" "}
                      <small>
                        Capacity of {event.max_attendees} applies per date
                      </small>
                    </>
                  )}
                </td>
              </tr>
              {hasMultiQuantity ? (
                <>
                  <tr>
                    <th>
                      Tickets Checked In
                      {isDaily
                        ? dateFilter
                          ? ` (${formatDateLabel(dateFilter)})`
                          : " (total)"
                        : ""}
                    </th>
                    <td>
                      <span>
                        {attendeesCheckedIn} / {completeAttendees.length}{" "}
                        &mdash; {attendeesCheckedInRemaining} remain
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <th>
                      Attendees Checked In
                      {isDaily
                        ? dateFilter
                          ? ` (${formatDateLabel(dateFilter)})`
                          : " (total)"
                        : ""}
                    </th>
                    <td>
                      <span>
                        {ticketsCheckedIn} / {completeQuantitySum} &mdash;{" "}
                        {ticketsCheckedInRemaining} remain
                      </span>
                    </td>
                  </tr>
                </>
              ) : (
                <tr>
                  <th>
                    Checked In
                    {isDaily
                      ? dateFilter
                        ? ` (${formatDateLabel(dateFilter)})`
                        : " (total)"
                      : ""}
                  </th>
                  <td>
                    <span>
                      {ticketsCheckedIn} / {completeQuantitySum} &mdash;{" "}
                      {ticketsCheckedInRemaining} remain
                    </span>
                  </td>
                </tr>
              )}
              {hasPaidEvent && (
                <tr>
                  <th>Total Revenue</th>
                  <td>
                    {formatCurrency(calculateTotalRevenue(completeAttendees))}
                  </td>
                </tr>
              )}
              <tr>
                <th>Registration Closes</th>
                <td>
                  {event.closes_at ? (
                    <span>
                      {formatDatetimeLabel(event.closes_at)}{" "}
                      <small>
                        <em>({formatCountdown(event.closes_at)})</em>
                      </small>
                    </span>
                  ) : (
                    <em>No deadline</em>
                  )}
                </td>
              </tr>
              <tr>
                <th>Public URL</th>
                <td>
                  <a
                    href={ticketUrl}
                  >{`${allowedDomain}/ticket/${event.slug}`}</a>
                  <small>
                    {" "}
                    (<a href={`/ticket/${event.slug}/qr`}>QR Code</a>)
                  </small>
                </td>
              </tr>
              {event.thank_you_url && (
                <tr>
                  <th>
                    <label for={`thank-you-url-${event.id}`}>
                      Thank You URL
                    </label>
                  </th>
                  <td>
                    <input
                      type="text"
                      id={`thank-you-url-${event.id}`}
                      value={event.thank_you_url}
                      readonly
                      data-select-on-click
                    />
                  </td>
                </tr>
              )}
              {event.webhook_url && (
                <tr>
                  <th>
                    <label for={`webhook-url-${event.id}`}>Webhook URL</label>
                  </th>
                  <td>
                    <input
                      type="text"
                      id={`webhook-url-${event.id}`}
                      value={event.webhook_url}
                      readonly
                      data-select-on-click
                    />
                  </td>
                </tr>
              )}
              <tr>
                <th>
                  <label for={`embed-script-${event.id}`}>Embed Script</label>
                </th>
                <td>
                  <input
                    type="text"
                    id={`embed-script-${event.id}`}
                    value={embedScriptCode}
                    readonly
                    data-select-on-click
                  />
                </td>
              </tr>
              <tr>
                <th>
                  <label for={`embed-iframe-${event.id}`}>Embed Iframe</label>
                </th>
                <td>
                  <input
                    type="text"
                    id={`embed-iframe-${event.id}`}
                    value={embedIframeCode}
                    readonly
                    data-select-on-click
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article>
        <h2 id="attendees">Attendees</h2>
        {checkinMessage && (
          <p id="message" class={checkedInClass}>
            Checked {checkinMessage.name} {checkedInLabel}
          </p>
        )}
        {isDaily && availableDates.length > 0 && (
          <Raw
            html={DateSelector({
              basePath,
              activeFilter,
              dateFilter,
              dates: availableDates,
            })}
          />
        )}
        <p>
          <Raw
            html={FilterLink({
              href: `${basePath}${dateQs}#attendees`,
              label: "All",
              active: activeFilter === "all",
            })}
          />
          {" / "}
          <Raw
            html={FilterLink({
              href: `${basePath}/in${dateQs}#attendees`,
              label: "Checked In",
              active: activeFilter === "in",
            })}
          />
          {" / "}
          <Raw
            html={FilterLink({
              href: `${basePath}/out${dateQs}#attendees`,
              label: "Checked Out",
              active: activeFilter === "out",
            })}
          />
        </p>
        <div class="table-scroll">
          <Raw
            html={AttendeeTable({
              rows: tableRows,
              allowedDomain,
              showEvent: false,
              showDate: isDaily,
              activeFilter,
              returnUrl,
              phonePrefix,
            })}
          />
        </div>
      </article>

      {incompleteAttendees.length > 0 && (
        <article>
          <h2 id="failed-payments">Failed Payments</h2>
          <p>
            {incompleteAttendees.length} attendee(s) with unresolved payments
          </p>
          <div class="table-scroll">
            <Raw
              html={FailedPaymentsTable({
                attendees: incompleteAttendees,
                eventId: event.id,
              })}
            />
          </div>
        </article>
      )}

      <article>
        <h2 id="add-attendee">Add Attendee</h2>
        <CsrfForm action={`/admin/event/${event.id}/attendee`}>
          <Raw
            html={renderFields(
              getAddAttendeeFields(event.fields, event.event_type === "daily"),
            )}
          />
          <button type="submit">Add Attendee</button>
        </CsrfForm>
      </article>
    </Layout>,
  );
};

/** Format an ISO datetime string for datetime-local input (YYYY-MM-DDTHH:MM) */
const formatDatetimeLocal = (iso: string | null): string | null => {
  if (!iso) return null;
  return utcToLocalInput(iso, getTz());
};

/** Convert bookable_days array to comma-separated display string */
const formatBookableDays = (days: string[]): string => days.join(",");

const eventToFieldValues = (event: EventWithCount): FieldValues => ({
  name: event.name,
  description: event.description,
  date: event.date ? formatDatetimeLocal(event.date) : null,
  location: event.location,
  slug: event.slug,
  event_type: event.event_type,
  group_id: event.group_id,
  max_attendees: event.max_attendees,
  max_quantity: event.max_quantity,
  bookable_days: formatBookableDays(event.bookable_days),
  minimum_days_before: event.minimum_days_before,
  maximum_days_after: event.maximum_days_after,
  fields: event.fields,
  unit_price: event.unit_price > 0 ? toMajorUnits(event.unit_price) : "",
  can_pay_more: event.can_pay_more ? "1" : "",
  max_price: toMajorUnits(event.max_price),
  closes_at: formatDatetimeLocal(event.closes_at),
  thank_you_url: event.thank_you_url,
  webhook_url: event.webhook_url,
  non_transferable: event.non_transferable ? "1" : "",
  hidden: event.hidden ? "1" : "",
});

/** Event fields with autofocus on the name field */
const eventFieldsWithAutofocus: Field[] = pipe(
  map((f: Field): Field => (f.name === "name" ? { ...f, autofocus: true } : f)),
)(eventFields);

/**
 * Admin event create page
 */
export const adminEventNewPage = (
  groups: Group[],
  session: AdminSession,
  error?: string,
): string => {
  const storageEnabled = isStorageEnabled();
  const fields = storageEnabled
    ? [...eventFields, imageField, attachmentField]
    : eventFields;
  return String(
    <Layout title="Add Event">
      <AdminNav session={session} active="/admin/" />
      <Breadcrumb href="/admin/" label="Events" />
      <h1>Add Event</h1>
      <Raw html={renderError(error)} />
      <CsrfForm action="/admin/event" enctype="multipart/form-data">
        <Raw html={renderFields(fields)} />
        <EventGroupSelect groups={groups} selectedGroupId={0} />
        <button type="submit">Create Event</button>
      </CsrfForm>
    </Layout>,
  );
};

/**
 * Admin duplicate event page - create form pre-filled with existing event settings
 */
export const adminDuplicateEventPage = (
  event: EventWithCount,
  groups: Group[],
  session: AdminSession,
): string => {
  const storageEnabled = isStorageEnabled();
  const fields = storageEnabled
    ? [...eventFieldsWithAutofocus, imageField, attachmentField]
    : eventFieldsWithAutofocus;
  const values = eventToFieldValues(event);
  values.name = "";

  return String(
    <Layout title={`Duplicate: ${event.name}`}>
      <AdminNav session={session} active="/admin/" />
      <h2>Duplicate Event</h2>
      <p>
        Creating a new event based on <strong>{event.name}</strong>.
      </p>
      <CsrfForm action="/admin/event" enctype="multipart/form-data">
        <Raw html={renderFields(fields, values)} />
        <EventGroupSelect groups={groups} selectedGroupId={event.group_id} />
        <button type="submit">Create Event</button>
      </CsrfForm>
    </Layout>,
  );
};

/**
 * Admin event edit page
 */
export const adminEventEditPage = (
  event: EventWithCount,
  groups: Group[],
  session: AdminSession,
  error?: string,
): string => {
  const storageEnabled = isStorageEnabled();
  const fields = storageEnabled
    ? [...eventFields, imageField, attachmentField]
    : eventFields;
  return String(
    <Layout title={`Edit: ${event.name}`}>
      <AdminNav session={session} active="/admin/" />
      <Raw html={renderError(error)} />
      <CsrfForm
        action={`/admin/event/${event.id}/edit`}
        enctype="multipart/form-data"
      >
        <Raw html={renderFields(fields, eventToFieldValues(event))} />
        <EventGroupSelect groups={groups} selectedGroupId={event.group_id} />
        <Raw html={renderField(slugField, String(event.slug))} />
        {storageEnabled && event.image_url && (
          <Raw html={renderEventImage(event, "event-image-full")} />
        )}
        <button type="submit">Save Changes</button>
      </CsrfForm>
      {storageEnabled && event.image_url && (
        <CsrfForm action={`/admin/event/${event.id}/image/delete`}>
          <button type="submit" class="secondary">
            Remove Image
          </button>
        </CsrfForm>
      )}
      {storageEnabled && event.attachment_name && (
        <div class="attachment-info">
          <p>
            Current attachment: <strong>{event.attachment_name}</strong>
          </p>
          <CsrfForm action={`/admin/event/${event.id}/attachment/delete`}>
            <button type="submit" class="secondary">
              Remove Attachment
            </button>
          </CsrfForm>
        </div>
      )}
    </Layout>,
  );
};

/**
 * Admin delete event confirmation page
 */
export const adminDeleteEventPage = (
  event: EventWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Delete: ${event.name}`}>
      <AdminNav session={session} active="/admin/" />
      {error && <div class="error">{error}</div>}

      <article>
        <aside>
          <p>
            <strong>Warning:</strong> This will permanently delete the event,
            all {event.attendee_count} attendee(s), any associated payment
            records, and all activity log entries for this event.
          </p>
        </aside>
      </article>

      <p>
        To delete this event, type its name "{event.name}" into the box below:
      </p>

      <CsrfForm action={`/admin/event/${event.id}/delete`}>
        <label for="confirm_identifier">Event name</label>
        <input
          type="text"
          id="confirm_identifier"
          name="confirm_identifier"
          placeholder={event.name}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          Delete Event
        </button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin deactivate event confirmation page
 */
export const adminDeactivateEventPage = (
  event: EventWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Deactivate: ${event.name}`}>
      <AdminNav session={session} active="/admin/" />
      {error && <div class="error">{error}</div>}

      <article>
        <aside>
          <p>
            <strong>Warning:</strong> Deactivating this event will:
          </p>
          <ul>
            <li>Return a 404 error on the public ticket page</li>
            <li>Prevent new registrations</li>
            <li>Reject any pending payments</li>
          </ul>
          <p>Existing attendees will not be affected.</p>
        </aside>
      </article>

      <p>
        To deactivate this event, type its name "{event.name}" into the box
        below:
      </p>

      <CsrfForm action={`/admin/event/${event.id}/deactivate`}>
        <label for="confirm_identifier">Event name</label>
        <input
          type="text"
          id="confirm_identifier"
          name="confirm_identifier"
          placeholder={event.name}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          Deactivate Event
        </button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin reactivate event confirmation page
 */
export const adminReactivateEventPage = (
  event: EventWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Reactivate: ${event.name}`}>
      <AdminNav session={session} active="/admin/" />
      {error && <div class="error">{error}</div>}

      <article>
        <aside>
          <p>
            Reactivating this event will make it available for registrations
            again.
          </p>
          <p>
            The public ticket page will be accessible and new attendees can
            register.
          </p>
        </aside>
      </article>

      <p>
        To reactivate this event, type its name "{event.name}" into the box
        below:
      </p>

      <CsrfForm action={`/admin/event/${event.id}/reactivate`}>
        <label for="confirm_identifier">Event name</label>
        <input
          type="text"
          id="confirm_identifier"
          name="confirm_identifier"
          placeholder={event.name}
          autocomplete="off"
          required
        />
        <button type="submit">Reactivate Event</button>
      </CsrfForm>
    </Layout>,
  );
