/**
 * External order library toggle form for advanced settings.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { booleanSettingsSection } from "#templates/admin/settings/boolean-settings-section.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
/* jscpd:ignore-end */

export const ExternalOrderForm =
  booleanSettingsSection<AdvancedSettingsPageState>({
    action: "/admin/settings/external-order",
    description: <p>{t("settings.advanced.external_order_hint")}</p>,
    fieldName: "external_order_enabled",
    title: t("settings.advanced.external_order"),
    value: (s) => s.externalOrderEnabled,
  });
