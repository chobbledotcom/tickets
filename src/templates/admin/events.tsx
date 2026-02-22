/**
 * Admin event page templates - detail, edit, delete
 */

import { filter, map, pipe, reduce } from "#fp";
import { formatCurrency, toMajorUnits } from "#lib/currency.ts";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import type { Field } from "#lib/forms.tsx";
import { CsrfForm, type FieldValues, renderError, renderField, renderFields } from "#lib/forms.tsx";
import { buildEmbedSnippets } from "#lib/embed.ts";
import { getTz } from "#lib/config.ts";
import { isStorageEnabled } from "#lib/storage.ts";
import { utcToLocalInput } from "#lib/timezone.ts";
import { renderEventImage } from "#templates/public.tsx";
import type { AdminSession, Attendee, EventWithCount, Group } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { formatCountdown } from "#routes/utils.ts";
import { eventFields, getAddAttendeeFields, imageField, slugField } from "#templates/fields.ts";
import { EventGroupSelect } from "#templates/admin/group-select.tsx";
import { Layout } from "#templates/layout.tsx";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";
import { AttendeeTable, type AttendeeTableRow } from "#templates/attendee-table.tsx";

/** Date option for the date filter dropdown */
export type DateOption = { value: string; label: string };

/** Attendee filter type */
export type AttendeeFilter = "all" | "in" | "out";

/** Re-export formatAddressInline from shared module for backwards compatibility */
export { formatAddressInline } from "#templates/attendee-table.tsx";

/** Calculate total revenue in cents from attendees */
export const calculateTotalRevenue = (attendees: Attendee[]): number =>
  reduce((sum: number, a: Attendee) =>
    sum + Number.parseInt(a.price_paid, 10), 0)(attendees);

/** Count how many attendees are checked in */
export const countCheckedIn = (attendees: Attendee[]): number =>
  filter((a: Attendee) => a.checked_in === "true")(attendees).length;


/** Check if event is within 10% of capacity */
export const nearCapacity = (event: EventWithCount): boolean =>
  event.attendee_count >= event.max_attendees * 0.9;


/** Check-in message to display after toggling */
export type CheckinMessage = { name: string; status: string } | null;

/** Add-attendee result message */
export type AddAttendeeMessage = { name: string } | { edited: string } | { error: string } | null;

/** Filter attendees by check-in status */
const filterAttendees = (attendees: Attendee[], activeFilter: AttendeeFilter): Attendee[] => {
  if (activeFilter === "in") return filter((a: Attendee) => a.checked_in === "true")(attendees);
  if (activeFilter === "out") return filter((a: Attendee) => a.checked_in !== "true")(attendees);
  return attendees;
};

/** Render a filter link, bold if active */
const FilterLink = ({ href, label, active }: { href: string; label: string; active: boolean }): string =>
  active
    ? String(<strong>{label}</strong>)
    : String(<a href={href}>{label}</a>);

/** Build the path suffix for a checkin filter (preserves date query) */
const filterSuffix = (activeFilter: AttendeeFilter): string =>
  activeFilter === "all" ? "" : `/${activeFilter}`;

/** Date selector dropdown for daily events */
const DateSelector = ({ basePath, activeFilter, dateFilter, dates }: { basePath: string; activeFilter: AttendeeFilter; dateFilter: string | null; dates: DateOption[] }): string => {
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
  addAttendeeMessage?: AddAttendeeMessage;
  imageError?: string | null;
  phonePrefix?: string;
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
  addAttendeeMessage = null,
  imageError = null,
  phonePrefix,
}: AdminEventPageOptions): string => {
  const ticketUrl = `https://${allowedDomain}/ticket/${event.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } = buildEmbedSnippets(ticketUrl);
  const isDaily = event.event_type === "daily";
  const filteredAttendees = filterAttendees(attendees, activeFilter);
  const hasPaidEvent = event.unit_price !== null;
  const checkedIn = countCheckedIn(attendees);
  const checkedInRemaining = attendees.length - checkedIn;
  const basePath = `/admin/event/${event.id}`;
  const dateQs = dateFilter ? `?date=${dateFilter}` : "";
  const suffix = filterSuffix(activeFilter);
  const returnUrl = `${basePath}${suffix}${dateQs}#attendees`;
  const tableRows: AttendeeTableRow[] = pipe(
    map((a: Attendee): AttendeeTableRow => ({
      attendee: a,
      eventId: event.id,
      eventName: event.name,
      hasPaidEvent,
    })),
  )(filteredAttendees);

  const checkedInLabel = checkinMessage?.status === "in" ? "in" : "out";
  const checkedInClass = checkinMessage?.status === "in" ? "checkin-message-in" : "checkin-message-out";

  return String(
    <Layout title={`Event: ${event.name}`}>
      <AdminNav session={session} />

        <h1>{event.name}</h1>
        <nav>
          <ul>
            <li><a href={`/admin/event/${event.id}/edit`}>Edit</a></li>
            <li><a href={`/admin/event/${event.id}/duplicate`}>Duplicate</a></li>
            <li><a href={`/admin/event/${event.id}/log`}>Log</a></li>
            <li><a href={`/admin/event/${event.id}/scanner`}>Scanner</a></li>
            <li><a href={`/admin/event/${event.id}/export${dateFilter ? `?date=${dateFilter}` : ""}`}>Export CSV</a></li>
            {hasPaidEvent && (
              <li><a href={`/admin/event/${event.id}/refund-all`} class="danger">Refund All</a></li>
            )}
            {event.active ? (
              <li><a href={`/admin/event/${event.id}/deactivate`} class="danger">Deactivate</a></li>
            ) : (
              <li><a href={`/admin/event/${event.id}/reactivate`}>Reactivate</a></li>
            )}
            <li><a href={`/admin/event/${event.id}/delete`} class="danger">Delete</a></li>
          </ul>
        </nav>

        {!event.active && (
          <div class="error">This event is deactivated and cannot be booked</div>
        )}

        {imageError && (
          <p class="error">Event saved but image was not uploaded: {imageError}</p>
        )}

        <article>
          <h2>Event Details</h2>
          <div class="table-scroll">
          <table>
            <tbody>
              {event.date && (
                <tr>
                  <th>Event Date</th>
                  <td>{formatDatetimeLabel(event.date)}</td>
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
              {event.event_type === "daily" && (
                <tr>
                  <th>Bookable Days</th>
                  <td>{formatBookableDays(event.bookable_days)}</td>
                </tr>
              )}
              {event.event_type === "daily" && (
                <tr>
                  <th>Booking Window</th>
                  <td>{event.minimum_days_before} to {event.maximum_days_after === 0 ? "unlimited" : event.maximum_days_after} days from today</td>
                </tr>
              )}
              <tr>
                <th>Attendees{isDaily ? dateFilter ? ` (${formatDateLabel(dateFilter)})` : " (total)" : ""}</th>
                <td>
                  {isDaily && dateFilter ? (
                    <span class={attendees.length >= event.max_attendees ? "danger-text" : ""}>
                      {attendees.length} / {event.max_attendees} &mdash; {event.max_attendees - attendees.length} remain
                    </span>
                  ) : (
                    <span class={nearCapacity(event) ? "danger-text" : ""}>
                      {event.attendee_count}{!isDaily && <> / {event.max_attendees} &mdash; {event.max_attendees - event.attendee_count} remain</>}
                    </span>
                  )}
                  {isDaily && !dateFilter && (
                    <>{" "}<small>Capacity of {event.max_attendees} applies per date</small></>
                  )}
                </td>
              </tr>
              <tr>
                <th>Checked In{isDaily ? dateFilter ? ` (${formatDateLabel(dateFilter)})` : " (total)" : ""}</th>
                <td>
                  <span>
                    {checkedIn} / {attendees.length} &mdash; {checkedInRemaining} remain
                  </span>
                </td>
              </tr>
              {event.unit_price !== null && (
                <tr>
                  <th>Total Revenue</th>
                  <td>{formatCurrency(calculateTotalRevenue(attendees))}</td>
                </tr>
              )}
              <tr>
                <th>Registration Closes</th>
                <td>
                  {event.closes_at ? (
                    <span>{formatDatetimeLabel(event.closes_at)} <small><em>({formatCountdown(event.closes_at)})</em></small></span>
                  ) : (
                    <em>No deadline</em>
                  )}
                </td>
              </tr>
              <tr>
                <th>Public URL</th>
                <td>
                  <a href={ticketUrl}>{`${allowedDomain}/ticket/${event.slug}`}</a>
                </td>
              </tr>
              <tr>
                <th><label for={`thank-you-url-${event.id}`}>Thank You URL</label></th>
                <td>
                  {event.thank_you_url ? (
                    <input
                      type="text"
                      id={`thank-you-url-${event.id}`}
                      value={event.thank_you_url}
                      readonly
                      data-select-on-click
                    />
                  ) : (
                    <em>None (shows simple success message)</em>
                  )}
                </td>
              </tr>
              {event.webhook_url && (
                <tr>
                  <th><label for={`webhook-url-${event.id}`}>Webhook URL</label></th>
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
                <th><label for={`embed-script-${event.id}`}>Embed Script</label></th>
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
                <th><label for={`embed-iframe-${event.id}`}>Embed Iframe</label></th>
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
            <Raw html={DateSelector({ basePath, activeFilter, dateFilter, dates: availableDates })} />
          )}
          <p>
            <Raw html={FilterLink({ href: `${basePath}${dateQs}#attendees`, label: "All", active: activeFilter === "all" })} />
            {" / "}
            <Raw html={FilterLink({ href: `${basePath}/in${dateQs}#attendees`, label: "Checked In", active: activeFilter === "in" })} />
            {" / "}
            <Raw html={FilterLink({ href: `${basePath}/out${dateQs}#attendees`, label: "Checked Out", active: activeFilter === "out" })} />
          </p>
          <div class="table-scroll">
            <Raw html={AttendeeTable({
              rows: tableRows,
              allowedDomain,
              showEvent: false,
              showDate: isDaily,
              activeFilter,
              returnUrl,
              phonePrefix,
            })} />
          </div>
        </article>

        <article>
          <h2 id="add-attendee">Add Attendee</h2>
          {addAttendeeMessage && "name" in addAttendeeMessage && (
            <p class="checkin-message-in">
              Added {addAttendeeMessage.name}
            </p>
          )}
          {addAttendeeMessage && "edited" in addAttendeeMessage && (
            <p class="checkin-message-in">
              Updated {addAttendeeMessage.edited}
            </p>
          )}
          {addAttendeeMessage && "error" in addAttendeeMessage && (
            <p class="error">
              {addAttendeeMessage.error}
            </p>
          )}
          <CsrfForm action={`/admin/event/${event.id}/attendee`}>
            <Raw html={renderFields(getAddAttendeeFields(event.fields, event.event_type === "daily"))} />
            <button type="submit">Add Attendee</button>
          </CsrfForm>
        </article>
    </Layout>
  );
};

/** Format an ISO datetime string for datetime-local input (YYYY-MM-DDTHH:MM) */
const formatDatetimeLocal = (iso: string | null): string | null => {
  if (!iso) return null;
  return utcToLocalInput(iso, getTz());
};

/** Convert bookable_days array to comma-separated display string */
const formatBookableDays = (days: string[]): string =>
  days.join(",");

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
  unit_price: event.unit_price !== null ? toMajorUnits(event.unit_price) : "",
  closes_at: formatDatetimeLocal(event.closes_at),
  thank_you_url: event.thank_you_url,
  webhook_url: event.webhook_url,
});

/** Event fields with autofocus on the name field */
const eventFieldsWithAutofocus: Field[] = pipe(
  map((f: Field): Field => f.name === "name" ? { ...f, autofocus: true } : f),
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
  const fields = storageEnabled ? [...eventFields, imageField] : eventFields;
  return String(
    <Layout title="Add Event">
      <AdminNav session={session} />
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
  const fields = storageEnabled ? [...eventFieldsWithAutofocus, imageField] : eventFieldsWithAutofocus;
  const values = eventToFieldValues(event);
  values.name = "";

  return String(
    <Layout title={`Duplicate: ${event.name}`}>
      <AdminNav session={session} />
        <h2>Duplicate Event</h2>
        <p>Creating a new event based on <strong>{event.name}</strong>.</p>
        <CsrfForm action="/admin/event" enctype="multipart/form-data">
          <Raw html={renderFields(fields, values)} />
          <EventGroupSelect groups={groups} selectedGroupId={event.group_id} />
          <button type="submit">Create Event</button>
        </CsrfForm>
    </Layout>
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
  const fields = storageEnabled ? [...eventFields, imageField] : eventFields;
  return String(
    <Layout title={`Edit: ${event.name}`}>
      <AdminNav session={session} />
        <Raw html={renderError(error)} />
        <CsrfForm action={`/admin/event/${event.id}/edit`} enctype="multipart/form-data">
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
            <button type="submit" class="secondary">Remove Image</button>
          </CsrfForm>
        )}
    </Layout>
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
      <AdminNav session={session} />
        {error && <div class="error">{error}</div>}

        <article>
          <aside>
            <p><strong>Warning:</strong> This will permanently delete the event, all {event.attendee_count} attendee(s), and any associated payment records.</p>
          </aside>
        </article>

        <p>To delete this event, type its name "{event.name}" into the box below:</p>

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
    </Layout>
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
      <AdminNav session={session} />
        {error && <div class="error">{error}</div>}

        <article>
          <aside>
            <p><strong>Warning:</strong> Deactivating this event will:</p>
            <ul>
              <li>Return a 404 error on the public ticket page</li>
              <li>Prevent new registrations</li>
              <li>Reject any pending payments</li>
            </ul>
            <p>Existing attendees will not be affected.</p>
          </aside>
        </article>

        <p>To deactivate this event, type its name "{event.name}" into the box below:</p>

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
    </Layout>
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
      <AdminNav session={session} />
        {error && <div class="error">{error}</div>}

        <article>
          <aside>
            <p>Reactivating this event will make it available for registrations again.</p>
            <p>The public ticket page will be accessible and new attendees can register.</p>
          </aside>
        </article>

        <p>To reactivate this event, type its name "{event.name}" into the box below:</p>

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
          <button type="submit">
            Reactivate Event
          </button>
        </CsrfForm>
    </Layout>
  );
