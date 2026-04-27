/**
 * Admin dashboard page template
 */

import { filter, joinStrings, map, pipe, reduce } from "#fp";
import {
  getHeaderText,
  renderCells,
  resolveColumnLayout,
} from "#shared/column-order.ts";
import {
  EVENT_DEFAULT_ORDER,
  EVENT_TABLE_COLUMNS,
} from "#shared/columns/event-columns.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { ActiveEventStats } from "#shared/db/attendees.ts";
import { isReadOnly } from "#shared/env.ts";
import { Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminSession,
  Attendee,
  AttendeeTableRow,
  EventWithCount,
} from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { AttendeeTable } from "#templates/attendee-table.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Render a single event table row using ordered column keys */
export const EventRow = ({
  e,
  columnKeys,
  filters,
}: {
  e: EventWithCount;
  columnKeys: string[];
  filters: Map<string, string>;
}): string => {
  const isInactive = !e.active;
  const cells = renderCells(
    e,
    columnKeys,
    EVENT_TABLE_COLUMNS,
    undefined,
    filters,
    escapeHtml,
  );
  return `<tr${isInactive ? ' class="inactive-row"' : ""}>${cells}</tr>`;
};

/** Checkbox item for multi-booking link builder */
const MultiBookingCheckbox = ({ e }: { e: EventWithCount }): string =>
  String(
    <li>
      <label>
        <input
          data-fields={e.fields}
          data-multi-booking-slug={e.slug}
          type="checkbox"
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
      <summary>Multi-booking link</summary>
      <p>Select events to generate a combined booking link:</p>
      <ul class="multi-booking-list">
        <Raw html={checkboxes} />
      </ul>
      <label for="multi-booking-url">Booking link</label>
      <input
        data-domain={getEffectiveDomain()}
        data-multi-booking-url
        data-select-on-click
        id="multi-booking-url"
        placeholder="Select two or more events"
        readonly
        type="text"
      />
      <label for="multi-booking-embed-script">Embed Script</label>
      <input
        data-multi-booking-embed-script
        data-select-on-click
        id="multi-booking-embed-script"
        placeholder="Select two or more events"
        readonly
        type="text"
      />
      <label for="multi-booking-embed-iframe">Embed Iframe</label>
      <input
        data-multi-booking-embed-iframe
        data-select-on-click
        id="multi-booking-embed-iframe"
        placeholder="Select two or more events"
        readonly
        type="text"
      />
    </details>,
  );
};

/** Active event statistics section */
export const activeEventStatsSection = (stats: ActiveEventStats): string =>
  String(
    <details>
      <summary>Active Event Statistics</summary>
      <ul>
        <li>
          <strong>Income:</strong> {formatCurrency(stats.income)}
        </li>
        <li>
          <strong>Tickets:</strong> {stats.tickets}
        </li>
        <li>
          <strong>Attendees:</strong> {stats.attendees}
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
        Newest {count} Attendee{count !== 1 ? "s" : ""}
      </summary>
      <div class="table-scroll">
        <Raw
          html={AttendeeTable({
            allowedDomain: getEffectiveDomain(),
            presorted: true,
            rows: tableRows,
            showActions: false,
            showDate: false,
            showEvent: true,
          })}
        />
      </div>
    </details>,
  );
};

/** Render the event table with dynamic column keys */
export const renderEventTable = (
  columnKeys: string[],
  rows: string,
): string => {
  const headers = pipe(
    map(
      (key: string) => `<th>${getHeaderText(EVENT_TABLE_COLUMNS[key]!)}</th>`,
    ),
    joinStrings,
  )(columnKeys);
  return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
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
  eventColumnTemplate?: string,
): string => {
  const { columnKeys, filters } = resolveColumnLayout(
    eventColumnTemplate ?? "",
    Object.keys(EVENT_TABLE_COLUMNS),
    EVENT_DEFAULT_ORDER,
  );

  const eventRows =
    events.length > 0
      ? pipe(
          map((e: EventWithCount) => EventRow({ columnKeys, e, filters })),
          joinStrings,
        )(events)
      : `<tr><td colspan="${columnKeys.length}">No events yet</td></tr>`;

  const activeEvents = filter((e: EventWithCount) => e.active)(events);

  return String(
    <Layout title="Events">
      <AdminNav active="/admin/" session={session} />

      <Flash error={imageError} success={successMessage} />

      {!isReadOnly() && (
        <p>
          <a href="/admin/event/new">Add Event</a>
        </p>
      )}

      <div class="table-scroll">
        <Raw html={renderEventTable(columnKeys, eventRows)} />
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
