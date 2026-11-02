/**
 * The run sheet's Liquid template boxes in advanced settings.
 *
 * Shown only while logistics is on, because the run sheet itself is the only
 * place these templates are rendered.
 */

import { t } from "#i18n";
import {
  runSheetTemplateSettingsFields,
  settingsFieldAttributes,
} from "#shared/settings/fields.ts";
import {
  DEFAULT_RUN_SHEET_BODY,
  DEFAULT_RUN_SHEET_HEADING,
} from "#templates/admin/deliveries/run-sheet-defaults.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { LiquidTemplateField } from "#templates/components/liquid-template-field.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { TemplateVariableTable } from "#templates/components/template-variable-table.tsx";

/** Every variable a run-sheet template can read, in the order the reference
 * table lists them. */
const RUN_SHEET_VARIABLES = [
  ["date", "settings.run_sheet.var.date"],
  ["date_label", "settings.run_sheet.var.date_label"],
  ["relative", "settings.run_sheet.var.relative"],
  ["labels.today", "settings.run_sheet.var.labels_today"],
  ["labels.tomorrow", "settings.run_sheet.var.labels_tomorrow"],
  ["labels.name", "settings.run_sheet.var.labels_name"],
  ["labels.listing", "settings.run_sheet.var.labels_listing"],
  ["labels.address", "settings.run_sheet.var.labels_address"],
  ["labels.phone", "settings.run_sheet.var.labels_phone"],
  ["labels.token", "settings.run_sheet.var.labels_token"],
  ["day.bookings", "settings.run_sheet.var.day_bookings"],
  ["booking.name", "settings.run_sheet.var.booking_name"],
  ["booking.listing", "settings.run_sheet.var.booking_listing"],
  ["booking.address", "settings.run_sheet.var.booking_address"],
  ["booking.maps_links", "settings.run_sheet.var.booking_maps_links"],
  ["booking.phone", "settings.run_sheet.var.booking_phone"],
  ["booking.phone_links", "settings.run_sheet.var.booking_phone_links"],
  ["booking.token", "settings.run_sheet.var.booking_token"],
  ["booking.legs", "settings.run_sheet.var.booking_legs"],
  ["leg.label", "settings.run_sheet.var.leg_label"],
  ["leg.time", "settings.run_sheet.var.leg_time"],
  ["leg.agent", "settings.run_sheet.var.leg_agent"],
  ["leg.done", "settings.run_sheet.var.leg_done"],
  ["leg.mark_form", "settings.run_sheet.var.leg_mark_form"],
  [
    "labels.nothing_scheduled",
    "settings.run_sheet.var.labels_nothing_scheduled",
  ],
] as const;

export const LogisticsRunSheetTemplateForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <SettingsSection
    action="/admin/settings/logistics-run-sheet"
    description={<p>{t("settings.run_sheet.hint")}</p>}
    submitLabel={t("settings.run_sheet.save")}
    title={t("settings.run_sheet.title")}
  >
    <details>
      <summary>{t("settings.run_sheet.available")}</summary>
      <TemplateVariableTable
        variables={RUN_SHEET_VARIABLES.map(([name, key]) => [
          `{{ ${name} }}`,
          key,
        ])}
      />
    </details>
    <LiquidTemplateField
      attributes={settingsFieldAttributes(
        runSheetTemplateSettingsFields(),
        "heading",
      )}
      defaultValue={DEFAULT_RUN_SHEET_HEADING}
      id="settings-logistics-run-sheet-heading"
      label={t("settings.run_sheet.heading")}
      rows={3}
      value={s.logisticsRunSheetHeading}
    />
    <LiquidTemplateField
      attributes={settingsFieldAttributes(
        runSheetTemplateSettingsFields(),
        "body",
      )}
      defaultValue={DEFAULT_RUN_SHEET_BODY}
      id="settings-logistics-run-sheet-body"
      label={t("settings.run_sheet.body")}
      rows={12}
      value={s.logisticsRunSheetBody}
    />
  </SettingsSection>
);
