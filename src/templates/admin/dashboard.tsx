/**
 * Admin dashboard page template
 */

import { filter, map, pipe, reduce } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { formatCurrency } from "#lib/currency.ts";
import type { ActiveEventStats } from "#lib/db/attendees.ts";
import { renderSuccess } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { t } from "#i18n";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  AttendeeTable,
  type AttendeeTableRow,
} from "#templates/attendee-table.tsx";
import { Layout } from "#templates/layout.tsx";
import { renderEventImage } from "#templates/public.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

export const EventRow = ({ e }: { e: EventWithCount }): string => {
  const isInactive = !e.active;
  return String(
    <tr class={isInactive ? "inactive-row" : undefined}>
      <td>
        <Raw html={renderEventImage(e, "event-thumbnail")} />
        <a href={`/admin/event/${e.id}`}>{e.name}</a>
      </td>
      <td class="cell-description">{e.description}</td>
      <td>{isInactive ? t("common.inactive") : t("common.active")}</td>
      <td>
        {e.attendee_count} / {e.max_attendees}
      </td>
      <td>{new Date(e.created).toLocaleDateString()}</td>
    </tr>,
  );
};

/** Checkbox item for multi-booking link builder */
const MultiBookingCheckbox = ({ e }: { e: EventWithCount }): string =>
  String(
    <li>
      <label>
        <input
          type="checkbox"
          data-multi-booking-slug={e.slug}
          data-fields={e.fields}
        />
        {` ${e.name}`}
      </label>
    </li>,
  );

/** Multi-booking link builder section (only rendered when 2+ active events) */
const multiBookingSection = (activeEvents: EventWithCount[]): string => {
  const checkboxes = pipe(
    map((e: EventWithCount) => MultiBookingCheckbox({ e })),
    joinStrings,
  )(activeEvents);

  return String(
    <details>
      <summary>{t("admin.dashboard.multi_booking_link")}</summary>
      <p>{t("admin.dashboard.multi_booking_desc")}</p>
      <ul class="multi-booking-list">
        <Raw html={checkboxes} />
      </ul>
      <label for="multi-booking-url">{t("admin.dashboard.booking_link")}</label>
      <input
        type="text"
        id="multi-booking-url"
        readonly
        data-select-on-click
        data-multi-booking-url
        data-domain={getAllowedDomain()}
        placeholder={t("admin.dashboard.select_two_or_more")}
      />
      <label for="multi-booking-embed-script">{t("admin.dashboard.embed_script")}</label>
      <input
        type="text"
        id="multi-booking-embed-script"
        readonly
        data-select-on-click
        data-multi-booking-embed-script
        placeholder={t("admin.dashboard.select_two_or_more")}
      />
      <label for="multi-booking-embed-iframe">{t("admin.dashboard.embed_iframe")}</label>
      <input
        type="text"
        id="multi-booking-embed-iframe"
        readonly
        data-select-on-click
        data-multi-booking-embed-iframe
        placeholder={t("admin.dashboard.select_two_or_more")}
      />
    </details>,
  );
};

/** Active event statistics section */
export const activeEventStatsSection = (stats: ActiveEventStats): string =>
  String(
    <details>
      <summary>{t("admin.dashboard.stats_heading")}</summary>
      <ul>
        <li>
          <strong>{t("admin.dashboard.income")}</strong> {formatCurrency(stats.income)}
        </li>
        <li>
          <strong>{t("admin.dashboard.tickets")}</strong> {stats.tickets}
        </li>
        <li>
          <strong>{t("admin.dashboard.attendees")}</strong> {stats.attendees}
        </li>
      </ul>
    </details>,
  );

/** Build the newest attendees section with a details/summary wrapper */
const newestAttendeesSection = (
  attendees: Attendee[],
  events: EventWithCount[],
): string => {
  const eventMap = new Map(events.map((e) => [e.id, e]));
  const tableRows = reduce((acc: AttendeeTableRow[], a: Attendee) => {
    const event = eventMap.get(a.event_id);
    if (event) {
      acc.push({
        attendee: a,
        eventId: event.id,
        eventName: event.name,
      });
    }
    return acc;
  }, [] as AttendeeTableRow[])(attendees);

  if (tableRows.length === 0) return "";

  const count = tableRows.length;

  return String(
    <details open>
      <summary>
        {t("admin.dashboard.newest_attendees", { count })}
      </summary>
      <div class="table-scroll">
        <Raw
          html={AttendeeTable({
            rows: tableRows,
            allowedDomain: getAllowedDomain(),
            showEvent: true,
            showDate: false,
            showActions: false,
            presorted: true,
          })}
        />
      </div>
    </details>,
  );
};

/**
 * Admin dashboard page
 */
export const adminDashboardPage = (
  events: EventWithCount[],
  session: AdminSession,
  imageError?: string,
  newestAttendees: Attendee[] = [],
  successMessage?: string,
  stats?: ActiveEventStats | null,
): string => {
  const eventRows =
    events.length > 0
      ? pipe(
          map((e: EventWithCount) => EventRow({ e })),
          joinStrings,
        )(events)
      : `<tr><td colspan="5">${t("admin.dashboard.no_events")}</td></tr>`;

  const activeEvents = filter((e: EventWithCount) => e.active)(events);

  return String(
    <Layout title={t("admin.dashboard.title")}>
      <AdminNav session={session} active="/admin/" />

      <Raw html={renderSuccess(successMessage)} />

      {imageError && <p class="error">{imageError}</p>}

      <p>
        <a href="/admin/event/new">{t("admin.dashboard.add_event")}</a>
      </p>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("admin.dashboard.col.event_name")}</th>
              <th>{t("admin.dashboard.col.description")}</th>
              <th>{t("admin.dashboard.col.status")}</th>
              <th>{t("admin.dashboard.col.attendees")}</th>
              <th>{t("admin.dashboard.col.created")}</th>
            </tr>
          </thead>
          <tbody>
            <Raw html={eventRows} />
          </tbody>
        </table>
      </div>

      {stats && <Raw html={activeEventStatsSection(stats)} />}

      {activeEvents.length >= 2 && (
        <Raw html={multiBookingSection(activeEvents)} />
      )}

      {newestAttendees.length > 0 && (
        <Raw html={newestAttendeesSection(newestAttendees, events)} />
      )}
    </Layout>,
  );
};
