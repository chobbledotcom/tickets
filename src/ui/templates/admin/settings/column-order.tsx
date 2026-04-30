/**
 * Column order settings forms for the advanced settings page.
 *
 * Users configure which columns appear (and in what order) for the
 * Events and Attendees tables using Liquid-style templates like:
 *   {{name}}, {{description}}, {{status}}, {{attendees}}, {{created}}
 */

import { buildDefaultTemplate } from "#shared/column-order.ts";
import {
  ATTENDEE_DEFAULT_ORDER,
  ATTENDEE_TABLE_COLUMNS,
} from "#shared/columns/attendee-columns.ts";
import {
  EVENT_DEFAULT_ORDER,
  EVENT_TABLE_COLUMNS,
} from "#shared/columns/event-columns.ts";
import { CsrfForm } from "#shared/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";

const eventDefault = buildDefaultTemplate(EVENT_DEFAULT_ORDER);
const attendeeDefault = buildDefaultTemplate(ATTENDEE_DEFAULT_ORDER);

/** Render available column tags as helper text */
const AvailableTags = ({
  columns,
}: {
  columns: Record<string, { label: string }>;
}): JSX.Element => (
  <small>
    Available:{" "}
    {Object.keys(columns)
      .map((key) => `{{${key}}}`)
      .join(", ")}
  </small>
);

export const EventColumnOrderForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <CsrfForm
    action="/admin/settings/event-column-order"
    id="settings-event-column-order"
  >
    <h2>Event Table Columns</h2>
    <p>
      Control which columns appear on the Events table and in what order. Use
      Liquid-style tags separated by commas. See the{" "}
      <a href="/admin/guide#column-order">Column Order guide</a> for full
      details including custom date and currency formatting.
    </p>
    <label>
      Column order
      <input
        autocomplete="off"
        name="column_order"
        placeholder={eventDefault}
        type="text"
        value={s.eventColumnOrder || eventDefault}
      />
    </label>
    <p>
      <AvailableTags columns={EVENT_TABLE_COLUMNS} />
    </p>
    <button type="submit">Save Event Columns</button>
  </CsrfForm>
);

export const AttendeeColumnOrderForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <CsrfForm
    action="/admin/settings/attendee-column-order"
    id="settings-attendee-column-order"
  >
    <h2>Attendee Table Columns</h2>
    <p>
      Control which columns appear on Attendee tables and in what order. Use
      Liquid-style tags separated by commas. Columns referencing absent data
      (e.g. email when no attendees have one) are hidden automatically. See the{" "}
      <a href="/admin/guide#column-order">Column Order guide</a> for full
      details including custom date and currency formatting.
    </p>
    <label>
      Column order
      <input
        autocomplete="off"
        name="column_order"
        placeholder={attendeeDefault}
        type="text"
        value={s.attendeeColumnOrder || attendeeDefault}
      />
    </label>
    <p>
      <AvailableTags columns={ATTENDEE_TABLE_COLUMNS} />
    </p>
    <button type="submit">Save Attendee Columns</button>
  </CsrfForm>
);
