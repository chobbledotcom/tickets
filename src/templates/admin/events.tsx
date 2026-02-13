/**
 * Admin event page templates - detail, edit, delete
 */

import { filter, map, pipe, reduce } from "#fp";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import type { Field } from "#lib/forms.tsx";
import { type FieldValues, renderError, renderField, renderFields } from "#lib/forms.tsx";
import { isStorageEnabled } from "#lib/storage.ts";
import { renderEventImage } from "#templates/public.tsx";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { formatCountdown } from "#routes/utils.ts";
import { eventFields, getAddAttendeeFields, parseEventFields, slugField } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

/** Date option for the date filter dropdown */
export type DateOption = { value: string; label: string };

/** Attendee filter type */
export type AttendeeFilter = "all" | "in" | "out";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

/** Calculate total revenue in cents from attendees */
export const calculateTotalRevenue = (attendees: Attendee[]): number =>
  reduce((sum: number, a: Attendee) => {
    if (a.price_paid) {
      return sum + Number.parseInt(a.price_paid, 10);
    }
    return sum;
  }, 0)(attendees);

/** Format cents as a decimal string (e.g. 1000 -> "10.00", "2999" -> "29.99") */
export const formatCents = (cents: string | number): string => (Number(cents) / 100).toFixed(2);

/** Check if event is within 10% of capacity */
export const nearCapacity = (event: EventWithCount): boolean =>
  event.attendee_count >= event.max_attendees * 0.9;

/** Format a multi-line address for inline display */
export const formatAddressInline = (address: string): string => {
  if (!address) return "";
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line)
    .reduce((acc, line) => {
      if (!acc) return line;
      // If previous part already ends with comma, just add space
      return acc.endsWith(",") ? `${acc} ${line}` : `${acc}, ${line}`;
    }, "");
};


const CheckinButton = ({ a, eventId, csrfToken, activeFilter }: { a: Attendee; eventId: number; csrfToken: string; activeFilter: AttendeeFilter }): string => {
  const isCheckedIn = a.checked_in === "true";
  const label = isCheckedIn ? "Check out" : "Check in";
  const buttonClass = isCheckedIn ? "link-button checkout" : "link-button checkin";
  return String(
    <form
      method="POST"
      action={`/admin/event/${eventId}/attendee/${a.id}/checkin`}
      class="inline"
    >
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <input type="hidden" name="return_filter" value={activeFilter} />
      <button type="submit" class={buttonClass}>
        {label}
      </button>
    </form>
  );
};

const AttendeeRow = ({ a, eventId, csrfToken, activeFilter, allowedDomain, showDate, hasPaidEvent }: { a: Attendee; eventId: number; csrfToken: string; activeFilter: AttendeeFilter; allowedDomain: string; showDate: boolean; hasPaidEvent: boolean }): string =>
  String(
    <tr>
      <td>
        <Raw html={CheckinButton({ a, eventId, csrfToken, activeFilter })} />
      </td>
      {showDate && <td>{a.date ? formatDateLabel(a.date) : ""}</td>}
      <td>{a.name}</td>
      <td>{a.email || ""}</td>
      <td>{a.phone || ""}</td>
      <td>{formatAddressInline(a.address)}</td>
      <td>{formatAddressInline(a.special_instructions)}</td>
      <td>{a.quantity}</td>
      <td><a href={`https://${allowedDomain}/t/${a.ticket_token}`}>{a.ticket_token}</a></td>
      <td>{new Date(a.created).toLocaleString()}</td>
      <td>
        {hasPaidEvent && a.payment_id && (
          <a href={`/admin/event/${eventId}/attendee/${a.id}/refund`} class="danger">
            Refund
          </a>
        )}
        {" "}
        <a href={`/admin/event/${eventId}/attendee/${a.id}/delete`} class="danger">
          Delete
        </a>
      </td>
    </tr>
  );

/** Check-in message to display after toggling */
export type CheckinMessage = { name: string; status: string } | null;

/** Add-attendee result message */
export type AddAttendeeMessage = { name: string } | { error: string } | null;

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
}: AdminEventPageOptions): string => {
  const storageEnabled = isStorageEnabled();
  const ticketUrl = `https://${allowedDomain}/ticket/${event.slug}`;
  const contactFields = parseEventFields(event.fields);
  const textareaCount = ["address", "special_instructions"].filter((f) => contactFields.includes(f as "address" | "special_instructions")).length;
  const inputCount = contactFields.filter((f) => f !== "address" && f !== "special_instructions").length;
  const iframeHeight = `${14 + inputCount * 4 + textareaCount * 6}rem`;
  const embedCode = `<iframe src="${ticketUrl}?iframe=true" loading="lazy" style="border: none; width: 100%; height: ${iframeHeight}">Loading..</iframe>`;
  const isDaily = event.event_type === "daily";
  const filteredAttendees = filterAttendees(attendees, activeFilter);
  const hasPaidEvent = event.unit_price !== null;
  const colSpan = isDaily ? 10 : 9;
  const attendeeRows =
    filteredAttendees.length > 0
      ? pipe(
          map((a: Attendee) => AttendeeRow({ a, eventId: event.id, csrfToken: session.csrfToken, activeFilter, allowedDomain, showDate: isDaily, hasPaidEvent })),
          joinStrings,
        )(filteredAttendees)
      : `<tr><td colspan="${colSpan}">No attendees yet</td></tr>`;

  const checkedInLabel = checkinMessage?.status === "in" ? "in" : "out";
  const checkedInClass = checkinMessage?.status === "in" ? "checkin-message-in" : "checkin-message-out";

  const basePath = `/admin/event/${event.id}`;
  const dateQs = dateFilter ? `?date=${dateFilter}` : "";

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
            {event.active === 1 ? (
              <li><a href={`/admin/event/${event.id}/deactivate`} class="danger">Deactivate</a></li>
            ) : (
              <li><a href={`/admin/event/${event.id}/reactivate`}>Reactivate</a></li>
            )}
            <li><a href={`/admin/event/${event.id}/delete`} class="danger">Delete</a></li>
          </ul>
        </nav>

        {event.active !== 1 && (
          <div class="error">This event is deactivated and cannot be booked</div>
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
                    <small>Capacity of {event.max_attendees} applies per date</small>
                  )}
                </td>
              </tr>
              {event.unit_price !== null && (
                <tr>
                  <th>Total Revenue</th>
                  <td>{formatCents(calculateTotalRevenue(attendees))}</td>
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
                <th><label for={`embed-code-${event.id}`}>Embed Code</label></th>
                <td>
                  <input
                    type="text"
                    id={`embed-code-${event.id}`}
                    value={embedCode}
                    readonly
                    data-select-on-click
                  />
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </article>

        {storageEnabled && (
          <article>
            <h2>Event Image</h2>
            {imageError && <Raw html={renderError(imageError)} />}
            {event.image_url ? (
              <form method="POST" action={`/admin/event/${event.id}/image/delete`}>
                <Raw html={renderEventImage(event, "event-image-preview")} />
                <input type="hidden" name="csrf_token" value={session.csrfToken} />
                <button type="submit" class="secondary">Remove Image</button>
              </form>
            ) : (
              <form method="POST" action={`/admin/event/${event.id}/image`} enctype="multipart/form-data">
                <input type="hidden" name="csrf_token" value={session.csrfToken} />
                <label>
                  {"Upload Image (JPEG, PNG, GIF, WebP \u2014 max 256KB)"}
                  <input type="file" name="image" accept="image/jpeg,image/png,image/gif,image/webp" required />
                </label>
                <button type="submit">Upload</button>
              </form>
            )}
          </article>
        )}

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
            <table>
              <thead>
                <tr>
                  <th></th>
                  {isDaily && <th>Date</th>}
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Address</th>
                  <th>Special Instructions</th>
                  <th>Qty</th>
                  <th>Ticket</th>
                  <th>Registered</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <Raw html={attendeeRows} />
              </tbody>
            </table>
          </div>
        </article>

        <article>
          <h2 id="add-attendee">Add Attendee</h2>
          {addAttendeeMessage && "name" in addAttendeeMessage && (
            <p class="checkin-message-in">
              Added {addAttendeeMessage.name}
            </p>
          )}
          {addAttendeeMessage && "error" in addAttendeeMessage && (
            <p class="error">
              {addAttendeeMessage.error}
            </p>
          )}
          <form method="POST" action={`/admin/event/${event.id}/attendee`}>
            <input type="hidden" name="csrf_token" value={session.csrfToken} />
            <Raw html={renderFields(getAddAttendeeFields(event.fields, event.event_type === "daily"))} />
            <button type="submit">Add Attendee</button>
          </form>
        </article>
    </Layout>
  );
};

/** Format an ISO datetime string for datetime-local input (YYYY-MM-DDTHH:MM) */
const formatDatetimeLocal = (iso: string | null): string | null => {
  if (!iso) return null;
  // datetime-local expects YYYY-MM-DDTHH:MM format
  return iso.slice(0, 16);
};

/** Convert bookable_days JSON array to comma-separated display string */
const formatBookableDays = (json: string): string =>
  (JSON.parse(json) as string[]).join(",");

const eventToFieldValues = (event: EventWithCount): FieldValues => ({
  name: event.name,
  description: event.description,
  date: event.date ? formatDatetimeLocal(event.date) : null,
  location: event.location,
  slug: event.slug,
  event_type: event.event_type,
  max_attendees: event.max_attendees,
  max_quantity: event.max_quantity,
  bookable_days: formatBookableDays(event.bookable_days),
  minimum_days_before: event.minimum_days_before,
  maximum_days_after: event.maximum_days_after,
  fields: event.fields,
  unit_price: event.unit_price,
  closes_at: formatDatetimeLocal(event.closes_at),
  thank_you_url: event.thank_you_url,
  webhook_url: event.webhook_url,
});

/** Event fields with autofocus on the name field */
const eventFieldsWithAutofocus: Field[] = pipe(
  map((f: Field): Field => f.name === "name" ? { ...f, autofocus: true } : f),
)(eventFields);

/**
 * Admin duplicate event page - create form pre-filled with existing event settings
 */
export const adminDuplicateEventPage = (
  event: EventWithCount,
  session: AdminSession,
): string => {
  const values = eventToFieldValues(event);
  values.name = "";

  return String(
    <Layout title={`Duplicate: ${event.name}`}>
      <AdminNav session={session} />
        <h2>Duplicate Event</h2>
        <p>Creating a new event based on <strong>{event.name}</strong>.</p>
        <form method="POST" action="/admin/event">
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <Raw html={renderFields(eventFieldsWithAutofocus, values)} />
          <button type="submit">Create Event</button>
        </form>
    </Layout>
  );
};

/**
 * Admin event edit page
 */
export const adminEventEditPage = (
  event: EventWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Edit: ${event.name}`}>
      <AdminNav session={session} />
        <Raw html={renderError(error)} />
        <form method="POST" action={`/admin/event/${event.id}/edit`}>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <Raw html={renderFields(eventFields, eventToFieldValues(event))} />
          <Raw html={renderField(slugField, String(event.slug))} />
          <button type="submit">Save Changes</button>
        </form>
    </Layout>
  );

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
            <p><strong>Warning:</strong> This will permanently delete the event and all {event.attendee_count} attendee(s).</p>
          </aside>
        </article>

        <p>To delete this event, type its name "{event.name}" into the box below:</p>

        <form method="POST" action={`/admin/event/${event.id}/delete`}>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
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
        </form>
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

        <form method="POST" action={`/admin/event/${event.id}/deactivate`}>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
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
        </form>
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

        <form method="POST" action={`/admin/event/${event.id}/reactivate`}>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
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
        </form>
    </Layout>
  );
