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
import { configurableTableLayouts } from "#shared/tables/configurable.ts";
import type { TableLayoutDefinition } from "#shared/tables/layout.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { textSettingsSection } from "#templates/components/settings-field-section.tsx";

/* jscpd:ignore-end */

/** Shape describing a configurable-columns table for the column-order form:
 *  a typed `columns` array the form reads available keys from. */
type ConfigurableColumns<TKey extends string> = {
  keys: readonly TKey[];
};

/** Render available column tags as helper text */
const AvailableTags = <TKey extends string>({
  columns,
}: {
  columns: ConfigurableColumns<TKey>;
}): JSX.Element => (
  <small>
    {t("settings.column_order.available")}{" "}
    {columns.keys.map((key) => `{{${key}}}`).join(", ")}
  </small>
);

type ColumnOrderConfig<TKey extends string> = {
  action: string;
  descriptionKey: string;
  submitLabelKey: string;
  titleKey: string;
  placeholder: string;
  columns: TableLayoutDefinition<TKey>;
  getValue: (s: AdvancedSettingsPageState) => string;
};

/** A single column-order settings form. The two exports below specialise it. */
const columnOrderForm = <TKey extends string>(cfg: ColumnOrderConfig<TKey>) =>
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
  columns: configurableTableLayouts.listing,
  descriptionKey: "settings.column_order.listing_desc",
  getValue: (s) => s.listingColumnOrder,
  placeholder: configurableTableLayouts.listing.defaultTemplate,
  submitLabelKey: "settings.column_order.listing_submit",
  titleKey: "settings.column_order.listing_title",
});

export const AttendeeColumnOrderForm = columnOrderForm({
  action: "/admin/settings/attendee-column-order",
  columns: configurableTableLayouts.attendee,
  descriptionKey: "settings.column_order.attendee_desc",
  getValue: (s) => s.attendeeColumnOrder,
  placeholder: configurableTableLayouts.attendee.defaultTemplate,
  submitLabelKey: "settings.column_order.attendee_submit",
  titleKey: "settings.column_order.attendee_title",
});
