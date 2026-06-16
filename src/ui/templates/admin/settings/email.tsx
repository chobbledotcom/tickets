/**
 * Email Notifications form for advanced settings
 */

import { t } from "#i18n";
import { MASK_SENTINEL } from "#shared/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, VALID_EMAIL_PROVIDERS } from "#shared/email.ts";
import { CsrfForm } from "#shared/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const EmailNotificationsForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <>
    <SettingsSection
      action="/admin/settings/email"
      description={
        <p>
          {t("settings.advanced.email_notifications_hint")}{" "}
          <a href="/admin/guide#email">Setup guide</a>.
        </p>
      }
      submitLabel={t("settings.advanced.save_email_settings")}
      title={t("settings.advanced.email_notifications")}
    >
      <label>
        {t("settings.advanced.email_provider")}
        <select name="email_provider">
          <option selected={!s.emailProvider} value="">
            {s.hostEmailLabel || t("settings.advanced.email_none")}
          </option>
          {VALID_EMAIL_PROVIDERS.map((p) => (
            <option selected={s.emailProvider === p} value={p}>
              {EMAIL_PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("settings.advanced.api_key")}
        <input
          autocomplete="off"
          name="email_api_key"
          placeholder={t("settings.advanced.api_key_placeholder")}
          type="password"
          value={s.emailApiKeyConfigured ? MASK_SENTINEL : undefined}
        />
      </label>
      <label>
        {t("settings.advanced.from_address")}
        <input
          autocomplete="off"
          name="email_from_address"
          placeholder={s.businessEmail || "tickets@yourdomain.com"}
          type="email"
          value={s.emailFromAddress}
        />
      </label>
    </SettingsSection>
    {s.emailProvider && (
      <CsrfForm action="/admin/settings/email/test" id="settings-email-test">
        <SubmitButton class="secondary" icon="arrow-right">
          {t("settings.advanced.send_test_email")}
        </SubmitButton>
      </CsrfForm>
    )}
  </>
);
