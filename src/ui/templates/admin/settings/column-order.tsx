/**
 * Column order settings forms for the advanced settings page.
 *
 * Users configure which columns appear (and in what order) for the
 * Listings and Attendees tables using Liquid-style templates like:
 *   {{name}}, {{description}}, {{status}}, {{attendees}}, {{created}}
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { attendeeTable } from "#shared/tables/attendee-table.tsx";
import { listingTable } from "#shared/tables/listing-table.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { textSettingsSection } from "#templates/components/settings-field-section.tsx";

/* jscpd:ignore-end */

const listingDefault = listingTable.defaultTemplate;
const attendeeDefault = attendeeTable.defaultTemplate;

/** Shape describing a configurable-columns table for the column-order form:
 *  a typed `columns` array the form reads available keys from. */
type ConfigurableColumns = {
  columns: readonly { key: string; label?: string }[];
};

/** Render available column tags as helper text */
const AvailableTags = ({
  columns,
}: {
  columns: ConfigurableColumns;
}): JSX.Element => (
  <small>
    {t("settings.column_order.available")}{" "}
    {columns.columns.map((c) => `{{${c.key}}}`).join(", ")}
  </small>
);

type ColumnOrderConfig = {
  action: string;
  descriptionKey: string;
  submitLabelKey: string;
  titleKey: string;
  placeholder: string;
  columns: ConfigurableColumns;
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
  columns: listingTable,
  descriptionKey: "settings.column_order.listing_desc",
  getValue: (s) => s.listingColumnOrder,
  placeholder: listingDefault,
  submitLabelKey: "settings.column_order.listing_submit",
  titleKey: "settings.column_order.listing_title",
});

export const AttendeeColumnOrderForm = columnOrderForm({
  action: "/admin/settings/attendee-column-order",
  columns: attendeeTable,
  descriptionKey: "settings.column_order.attendee_desc",
  getValue: (s) => s.attendeeColumnOrder,
  placeholder: attendeeDefault,
  submitLabelKey: "settings.column_order.attendee_submit",
  titleKey: "settings.column_order.attendee_title",
});
