/**
 * Column order settings forms for the advanced settings page.
 *
 * Users configure which columns appear (and in what order) for the
 * Listings and Attendees tables using Liquid-style templates like:
 *   {{name}}, {{description}}, {{status}}, {{attendees}}, {{created}}
 */

import { t } from "#i18n";
import { buildDefaultTemplate } from "#shared/column-order.ts";
import {
  ATTENDEE_DEFAULT_ORDER,
  ATTENDEE_TABLE_COLUMNS,
} from "#shared/columns/attendee-columns.ts";
import {
  LISTING_DEFAULT_ORDER,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

const listingDefault = buildDefaultTemplate(LISTING_DEFAULT_ORDER);
const attendeeDefault = buildDefaultTemplate(ATTENDEE_DEFAULT_ORDER);

/** Render available column tags as helper text */
const AvailableTags = ({
  columns,
}: {
  columns: Record<string, { label: string }>;
}): JSX.Element => (
  <small>
    {t("settings.column_order.available")}{" "}
    {Object.keys(columns)
      .map((key) => `{{${key}}}`)
      .join(", ")}
  </small>
);

export const ListingColumnOrderForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <SettingsSection
    action="/admin/settings/listing-column-order"
    description={<Raw html={t("settings.column_order.listing_desc")} />}
    submitLabel={t("settings.column_order.listing_submit")}
    title={t("settings.column_order.listing_title")}
  >
    <label>
      {t("settings.column_order.label")}
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
  </SettingsSection>
);

export const AttendeeColumnOrderForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <SettingsSection
    action="/admin/settings/attendee-column-order"
    description={<Raw html={t("settings.column_order.attendee_desc")} />}
    submitLabel={t("settings.column_order.attendee_submit")}
    title={t("settings.column_order.attendee_title")}
  >
    <label>
      {t("settings.column_order.label")}
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
  </SettingsSection>
);
