/**
 * Email Notifications form for advanced settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { EMAIL_PROVIDER_LABELS, VALID_EMAIL_PROVIDERS } from "#shared/email.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { MaskedInput } from "#templates/components/masked-input.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { SelectField } from "#templates/components/select-field.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { TextField } from "#templates/components/text-field.tsx";
/* jscpd:ignore-end */

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
        <SelectField
          name="email_provider"
          options={[
            {
              label: s.hostEmailLabel || t("settings.advanced.email_none"),
              value: "",
            },
            ...VALID_EMAIL_PROVIDERS.map((p) => ({
              label: EMAIL_PROVIDER_LABELS[p],
              value: p,
            })),
          ]}
          value={s.emailProvider}
        />
      </label>
      <MaskedInput
        configured={s.emailApiKeyConfigured}
        label={t("settings.advanced.api_key")}
        name="email_api_key"
        placeholder={t("settings.advanced.api_key_placeholder")}
      />
      <TextField
        label={t("settings.advanced.from_address")}
        name="email_from_address"
        placeholder={s.businessEmail || "tickets@yourdomain.com"}
        type="email"
        value={s.emailFromAddress}
      />
    </SettingsSection>
    {s.emailProvider && (
      <SaveForm
        action="/admin/settings/email/test"
        id="settings-email-test"
        submitClass="secondary"
        submitIcon="arrow-right"
        submitLabel={t("settings.advanced.send_test_email")}
      />
    )}
  </>
);
