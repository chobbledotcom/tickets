/**
 * Admin event page templates - detail, edit, delete
 */

import { filter, map, pipe, reduce } from "#fp";
import type { Field } from "#lib/forms.tsx";
import { type FieldValues, renderError, renderField, renderFields } from "#lib/forms.tsx";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { formatCountdown } from "#routes/utils.ts";
import { eventFields, slugField } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

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

/** Format cents as a decimal string (e.g. 1000 -> "10.00") */
const formatRevenue = (cents: number): string => (cents / 100).toFixed(2);

/** Check if event is within 10% of capacity */
export const nearCapacity = (event: EventWithCount): boolean =>
  event.attendee_count >= event.max_attendees * 0.9;


const CheckinButton = ({ a, eventId, csrfToken, activeFilter }: { a: Attendee; eventId: number; csrfToken: string; activeFilter: AttendeeFilter }): string => {
  const isCheckedIn = a.checked_in === "true";
  const label = isCheckedIn ? "Check out" : "Check in";
  const buttonClass = isCheckedIn ? "checkout" : "checkin";
  return String(
    <form
      method="POST"
      action={`/admin/event/${eventId}/attendee/${a.id}/checkin`}
      class="checkin-form inline"
    >
      <input type="hidden" name="csrf_token" value={csrfToken} />
      <input type="hidden" name="return_filter" value={activeFilter} />
      <button type="submit" class={buttonClass}>
        {label}
      </button>
    </form>
  );
};

const AttendeeRow = ({ a, eventId, csrfToken, activeFilter, allowedDomain }: { a: Attendee; eventId: number; csrfToken: string; activeFilter: AttendeeFilter; allowedDomain: string }): string =>
  String(
    <tr>
      <td>{a.name}</td>
      <td>{a.email || ""}</td>
      <td>{a.phone || ""}</td>
      <td>{a.quantity}</td>
      <td><a href={`https://${allowedDomain}/t/${a.ticket_token}`}>{a.ticket_token}</a></td>
      <td>{new Date(a.created).toLocaleString()}</td>
      <td>
        <Raw html={CheckinButton({ a, eventId, csrfToken, activeFilter })} />
      </td>
      <td>
        <a href={`/admin/event/${eventId}/attendee/${a.id}/delete`} class="danger">
          Delete
        </a>
      </td>
    </tr>
  );

/** Check-in message to display after toggling */
export type CheckinMessage = { name: string; status: string } | null;

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

export const adminEventPage = (
  event: EventWithCount,
  attendees: Attendee[],
  allowedDomain: string,
  session: AdminSession,
  checkinMessage?: CheckinMessage,
  activeFilter: AttendeeFilter = "all",
): string => {
  const ticketUrl = `https://${allowedDomain}/ticket/${event.slug}`;
  const iframeHeight = event.fields === "both" ? "24rem" : "18rem";
  const embedCode = `<iframe src="${ticketUrl}?iframe=true" loading="lazy" style="border: none; width: 100%; height: ${iframeHeight}">Loading..</iframe>`;
  const filteredAttendees = filterAttendees(attendees, activeFilter);
  const attendeeRows =
    filteredAttendees.length > 0
      ? pipe(
          map((a: Attendee) => AttendeeRow({ a, eventId: event.id, csrfToken: session.csrfToken, activeFilter, allowedDomain })),
          joinStrings,
        )(filteredAttendees)
      : '<tr><td colspan="8">No attendees yet</td></tr>';

  const checkedInLabel = checkinMessage?.status === "in" ? "in" : "out";
  const checkedInClass = checkinMessage?.status === "in" ? "checkin-message-in" : "checkin-message-out";

  const basePath = `/admin/event/${event.id}`;

  return String(
    <Layout title={`Event: ${event.name}`}>
      <AdminNav session={session} />

        <h1>{event.name}</h1>
        <nav>
          <ul>
            <li><a href={`/admin/event/${event.id}/edit`}>Edit</a></li>
            <li><a href={`/admin/event/${event.id}/duplicate`}>Duplicate</a></li>
            <li><a href={`/admin/event/${event.id}/log`}>Log</a></li>
            <li><a href={`/admin/event/${event.id}/export`}>Export CSV</a></li>
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
              <tr>
                <th>Attendees</th>
                <td>
                  <span class={nearCapacity(event) ? "danger-text" : ""}>
                    {event.attendee_count} / {event.max_attendees} &mdash; {event.max_attendees - event.attendee_count} remain
                  </span>
                </td>
              </tr>
              {event.unit_price !== null && (
                <tr>
                  <th>Total Revenue</th>
                  <td>{formatRevenue(calculateTotalRevenue(attendees))}</td>
                </tr>
              )}
              <tr>
                <th>Registration Closes</th>
                <td>
                  {event.closes_at ? (
                    <span>{event.closes_at} (UTC) <small><em>({formatCountdown(event.closes_at)})</em></small></span>
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
                      onclick="this.select()"
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
                      onclick="this.select()"
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
                    onclick="this.select()"
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
          <p>
            <Raw html={FilterLink({ href: `${basePath}#attendees`, label: "All", active: activeFilter === "all" })} />
            {" / "}
            <Raw html={FilterLink({ href: `${basePath}/in#attendees`, label: "Checked In", active: activeFilter === "in" })} />
            {" / "}
            <Raw html={FilterLink({ href: `${basePath}/out#attendees`, label: "Checked Out", active: activeFilter === "out" })} />
          </p>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Qty</th>
                  <th>Ticket</th>
                  <th>Registered</th>
                  <th></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <Raw html={attendeeRows} />
              </tbody>
            </table>
          </div>
        </article>
    </Layout>
  );
};

/** Format closes_at ISO string for datetime-local input (YYYY-MM-DDTHH:MM) */
const formatClosesAt = (closesAt: string | null): string | null => {
  if (!closesAt) return null;
  // datetime-local expects YYYY-MM-DDTHH:MM format
  return closesAt.slice(0, 16);
};

const eventToFieldValues = (event: EventWithCount): FieldValues => ({
  name: event.name,
  description: event.description,
  slug: event.slug,
  max_attendees: event.max_attendees,
  max_quantity: event.max_quantity,
  fields: event.fields,
  unit_price: event.unit_price,
  closes_at: formatClosesAt(event.closes_at),
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
