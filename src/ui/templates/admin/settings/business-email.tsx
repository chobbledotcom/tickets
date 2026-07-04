/**
 * Business Email form for settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { textSettingsSection } from "#templates/components/settings-field-section.tsx";
/* jscpd:ignore-end */

export const BusinessEmailForm = textSettingsSection<SettingsPageState>({
  action: "/admin/settings/business-email",
  description: <p>{t("settings.business_email_hint")}</p>,
  getValue: (s) => s.businessEmail,
  label: t("settings.business_email"),
  name: "business_email",
  placeholder: "contact@example.com",
  submitLabel: t("settings.save_business_email"),
  title: t("settings.business_email"),
  type: "email",
});
