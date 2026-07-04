/**
 * Custom CSS form for advanced settings.
 *
 * Plain textarea (not markdown): the value is served verbatim as a public
 * stylesheet from /custom.css.
 */

import { t } from "#i18n";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { textareaSettingsSection } from "#templates/components/settings-field-section.tsx";

export const CustomCssForm = textareaSettingsSection<AdvancedSettingsPageState>(
  (s) => ({
    action: "/admin/settings/custom-css",
    description: <p>{t("settings.advanced.custom_css_hint")}</p>,
    label: t("settings.advanced.custom_css_label"),
    name: "custom_css",
    placeholder: t("settings.advanced.custom_css_placeholder"),
    submitLabel: t("settings.advanced.save_custom_css"),
    title: t("settings.advanced.custom_css"),
    value: s.customCss,
  }),
);
