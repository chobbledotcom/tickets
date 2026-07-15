/**
 * SMS Gateway form for advanced settings.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { MASK_SENTINEL } from "#shared/db/settings/mask.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { MaskedInput } from "#templates/components/masked-input.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { TextField } from "#templates/components/text-field.tsx";
/* jscpd:ignore-end */

export const SmsGatewayForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/sms-gateway"
    description={<Raw html={t("sms.settings.description")} />}
    submitLabel={t("sms.settings.save")}
    title={t("sms.settings.title")}
  >
    <TextField
      label={t("sms.settings.username")}
      name="sms_gateway_username"
      placeholder={t("sms.settings.username_placeholder")}
      type="text"
      value={s.smsGatewayUsername}
    />
    <MaskedInput
      configured={s.smsGatewayPasswordConfigured}
      label={t("sms.settings.password")}
      name="sms_gateway_password"
      placeholder={t("sms.settings.password_placeholder")}
    />
    <label>
      {t("sms.settings.passphrase")}
      <input
        autocomplete="off"
        minlength={SMS_PASSPHRASE_MIN_LENGTH}
        name="sms_gateway_passphrase"
        placeholder={t("sms.settings.passphrase_placeholder")}
        type="password"
        value={s.smsGatewayPassphraseConfigured ? MASK_SENTINEL : undefined}
      />
      <Raw html={t("sms.settings.passphrase_help")} />
    </label>
    <TextField
      label={t("sms.settings.base_url")}
      name="sms_gateway_base_url"
      placeholder={t("sms.settings.base_url_placeholder")}
      type="url"
      value={s.smsGatewayBaseUrl}
    />
    <MaskedInput
      configured={s.smsGatewayWebhookConfigured}
      label={t("sms.settings.webhook_secret")}
      name="sms_gateway_webhook_secret"
      placeholder={t("sms.settings.webhook_secret_placeholder")}
    />
    <Raw html={t("sms.settings.webhook_note")} />
  </SettingsSection>
);
