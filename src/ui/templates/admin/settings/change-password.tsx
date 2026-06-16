/**
 * Change Password form for settings
 */

import { t } from "#i18n";
import { renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { changePasswordFields } from "#templates/fields.ts";

export const ChangePasswordForm = (): JSX.Element => (
  <SettingsSection
    action="/admin/settings"
    description={<p>{t("settings.change_password_hint")}</p>}
    id="settings-password"
    submitLabel={t("settings.change_password")}
    title={t("settings.change_password")}
  >
    <Raw html={renderFields(changePasswordFields)} />
  </SettingsSection>
);
