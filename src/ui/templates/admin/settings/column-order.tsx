/**
 * Column order settings forms for the advanced settings page.
 *
 * Users configure which columns appear (and in what order) for the
 * Listings and Attendees tables using Liquid-style templates like:
 *   {{name}}, {{description}}, {{status}}, {{attendees}}, {{created}}
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { buildDefaultTemplate, COLUMN_LAYOUTS } from "#shared/column-order.ts";
import { ATTENDEE_TABLE_COLUMNS } from "#shared/columns/attendee-columns.ts";
import { LISTING_TABLE_COLUMNS } from "#shared/columns/listing-columns.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { textSettingsSection } from "#templates/components/settings-field-section.tsx";

/* jscpd:ignore-end */

const listingDefault = buildDefaultTemplate(
  COLUMN_LAYOUTS.listing.defaultOrder,
);
const attendeeDefault = buildDefaultTemplate(
  COLUMN_LAYOUTS.attendee.defaultOrder,
);

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

type ColumnOrderConfig = {
  action: string;
  descriptionKey: string;
  submitLabelKey: string;
  titleKey: string;
  placeholder: string;
  columns: Record<string, { label: string }>;
  getValue: (s: AdvancedSettingsPageState) => string;
};

/** A single column-order settings form. The two exports below specialise it. */
const columnOrderForm = (cfg: ColumnOrderConfig) =>
  textSettingsSection<AdvancedSettingsPageState>((s) => ({
    action: cfg.action,
    description: <Raw html={t(cfg.descriptionKey)} />,
    footer: (
      <p>
        <AvailableTags columns={cfg.columns} />
      </p>
    ),
    label: t("settings.column_order.label"),
    name: "column_order",
    placeholder: cfg.placeholder,
    submitLabel: t(cfg.submitLabelKey),
    title: t(cfg.titleKey),
    type: "text",
    value: cfg.getValue(s) || cfg.placeholder,
  }));

export const ListingColumnOrderForm = columnOrderForm({
  action: "/admin/settings/listing-column-order",
  columns: LISTING_TABLE_COLUMNS,
  descriptionKey: "settings.column_order.listing_desc",
  getValue: (s) => s.listingColumnOrder,
  placeholder: listingDefault,
  submitLabelKey: "settings.column_order.listing_submit",
  titleKey: "settings.column_order.listing_title",
});

export const AttendeeColumnOrderForm = columnOrderForm({
  action: "/admin/settings/attendee-column-order",
  columns: ATTENDEE_TABLE_COLUMNS,
  descriptionKey: "settings.column_order.attendee_desc",
  getValue: (s) => s.attendeeColumnOrder,
  placeholder: attendeeDefault,
  submitLabelKey: "settings.column_order.attendee_submit",
  titleKey: "settings.column_order.attendee_title",
});
