/**
 * Column order settings forms for the advanced settings page.
 *
 * Users configure which columns appear (and in what order) for the
 * Listings and Attendees tables using Liquid-style templates like:
 *   {{name}}, {{description}}, {{status}}, {{attendees}}, {{created}}
 */

/* jscpd:ignore-start */
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
import { TextField } from "#templates/components/text-field.tsx";

/* jscpd:ignore-end */

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

type ColumnOrderField = {
  action: string;
  descriptionKey: string;
  submitLabelKey: string;
  titleKey: string;
  placeholder: string;
  value: string;
  columns: Record<string, { label: string }>;
};

/** A single column-order settings form. The two exports below specialise it. */
const ColumnOrderForm = ({
  action,
  descriptionKey,
  submitLabelKey,
  titleKey,
  placeholder,
  value,
  columns,
}: ColumnOrderField): JSX.Element => (
  <SettingsSection
    action={action}
    description={<Raw html={t(descriptionKey)} />}
    submitLabel={t(submitLabelKey)}
    title={t(titleKey)}
  >
    <TextField
      label={t("settings.column_order.label")}
      name="column_order"
      placeholder={placeholder}
      type="text"
      value={value || placeholder}
    />
    <p>
      <AvailableTags columns={columns} />
    </p>
  </SettingsSection>
);

export const ListingColumnOrderForm = (
  s: AdvancedSettingsPageState,
): JSX.Element =>
  ColumnOrderForm({
    action: "/admin/settings/listing-column-order",
    columns: LISTING_TABLE_COLUMNS,
    descriptionKey: "settings.column_order.listing_desc",
    placeholder: listingDefault,
    submitLabelKey: "settings.column_order.listing_submit",
    titleKey: "settings.column_order.listing_title",
    value: s.listingColumnOrder,
  });

export const AttendeeColumnOrderForm = (
  s: AdvancedSettingsPageState,
): JSX.Element =>
  ColumnOrderForm({
    action: "/admin/settings/attendee-column-order",
    columns: ATTENDEE_TABLE_COLUMNS,
    descriptionKey: "settings.column_order.attendee_desc",
    placeholder: attendeeDefault,
    submitLabelKey: "settings.column_order.attendee_submit",
    titleKey: "settings.column_order.attendee_title",
    value: s.attendeeColumnOrder,
  });
