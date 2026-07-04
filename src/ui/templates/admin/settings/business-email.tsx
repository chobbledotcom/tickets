/**
 * Business Email form for settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { TextField } from "#templates/components/text-field.tsx";
/* jscpd:ignore-end */

export const BusinessEmailForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/business-email"
    description={<p>{t("settings.business_email_hint")}</p>}
    submitLabel={t("settings.save_business_email")}
    title={t("settings.business_email")}
  >
    <TextField
      label={t("settings.business_email")}
      name="business_email"
      placeholder="contact@example.com"
      type="email"
      value={s.businessEmail}
    />
  </SettingsSection>
);
