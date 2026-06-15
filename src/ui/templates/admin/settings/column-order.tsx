/**
 * Column order settings forms for the advanced settings page.
 *
 * Users configure which columns appear (and in what order) for the
 * Listings and Attendees tables using Liquid-style templates like:
 *   {{name}}, {{description}}, {{status}}, {{attendees}}, {{created}}
 */

import { buildDefaultTemplate } from "#shared/column-order.ts";
import {
  ATTENDEE_DEFAULT_ORDER,
  ATTENDEE_TABLE_COLUMNS,
} from "#shared/columns/attendee-columns.ts";
import {
  LISTING_DEFAULT_ORDER,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";
import { CsrfForm } from "#shared/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

const listingDefault = buildDefaultTemplate(LISTING_DEFAULT_ORDER);
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

export const ListingColumnOrderForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <CsrfForm
    action="/admin/settings/listing-column-order"
    id="settings-listing-column-order"
  >
    <div class="prose">
      <h2>Listing Table Columns</h2>
      <p>
        Control which columns appear on the Listings table and in what order.
        Use Liquid-style tags separated by commas. See the{" "}
        <a href="/admin/guide#column-order">Column Order guide</a> for full
        details including custom date and currency formatting.
      </p>
    </div>
    <label>
      Column order
      <input
        autocomplete="off"
        name="column_order"
        placeholder={listingDefault}
        type="text"
        value={s.listingColumnOrder || listingDefault}
      />
    </label>
    <p>
      <AvailableTags columns={LISTING_TABLE_COLUMNS} />
    </p>
    <SubmitButton icon="save">Save Listing Columns</SubmitButton>
  </CsrfForm>
);

export const AttendeeColumnOrderForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <CsrfForm
    action="/admin/settings/attendee-column-order"
    id="settings-attendee-column-order"
  >
    <div class="prose">
      <h2>Attendee Table Columns</h2>
      <p>
        Control which columns appear on Attendee tables and in what order. Use
        Liquid-style tags separated by commas. Columns referencing absent data
        (e.g. email when no attendees have one) are hidden automatically. See
        the <a href="/admin/guide#column-order">Column Order guide</a> for full
        details including custom date and currency formatting.
      </p>
    </div>
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
    <SubmitButton icon="save">Save Attendee Columns</SubmitButton>
  </CsrfForm>
);
