/**
 * Business Email form for settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { textSettingsSection } from "#templates/components/settings-field-section.tsx";
/* jscpd:ignore-end */

export const BusinessEmailForm = textSettingsSection<SettingsPageState>(
  (s) => ({
    action: "/admin/settings/business-email",
    description: <p>{t("settings.business_email_hint")}</p>,
    label: t("settings.business_email"),
    name: "business_email",
    placeholder: t("settings.business_email_placeholder"),
    submitLabel: t("settings.save_business_email"),
    title: t("settings.business_email"),
    type: "email",
    value: s.businessEmail,
  }),
);
