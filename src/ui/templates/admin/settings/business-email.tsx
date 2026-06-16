/**
 * Business Email form for settings
 */

import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const BusinessEmailForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/business-email"
    description={<p>{t("settings.business_email_hint")}</p>}
    submitLabel={t("settings.save_business_email")}
    title={t("settings.business_email")}
  >
    <label>
      {t("settings.business_email")}
      <input
        autocomplete="email"
        name="business_email"
        placeholder="contact@example.com"
        type="email"
        value={s.businessEmail}
      />
    </label>
  </SettingsSection>
);
