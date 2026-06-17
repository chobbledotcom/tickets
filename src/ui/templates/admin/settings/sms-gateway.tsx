/**
 * SMS Gateway form for advanced settings.
 */

import { t } from "#i18n";
import { MASK_SENTINEL } from "#shared/db/settings.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const SmsGatewayForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/sms-gateway"
    description={<Raw html={t("sms.settings.description")} />}
    submitLabel={t("sms.settings.save")}
    title={t("sms.settings.title")}
  >
    <label>
      {t("sms.settings.username")}
      <input
        autocomplete="off"
        name="sms_gateway_username"
        placeholder={t("sms.settings.username_placeholder")}
        type="text"
        value={s.smsGatewayUsername}
      />
    </label>
    <label>
      {t("sms.settings.password")}
      <input
        autocomplete="off"
        name="sms_gateway_password"
        placeholder={t("sms.settings.password_placeholder")}
        type="password"
        value={s.smsGatewayPasswordConfigured ? MASK_SENTINEL : undefined}
      />
    </label>
    <label>
      {t("sms.settings.passphrase")}
      <input
        autocomplete="off"
        name="sms_gateway_passphrase"
        placeholder={t("sms.settings.passphrase_placeholder")}
        type="password"
        value={s.smsGatewayPassphraseConfigured ? MASK_SENTINEL : undefined}
      />
      <Raw html={t("sms.settings.passphrase_help")} />
    </label>
    <label>
      {t("sms.settings.base_url")}
      <input
        autocomplete="off"
        name="sms_gateway_base_url"
        placeholder={t("sms.settings.base_url_placeholder")}
        type="url"
        value={s.smsGatewayBaseUrl}
      />
    </label>
    <label>
      {t("sms.settings.webhook_secret")}
      <input
        autocomplete="off"
        name="sms_gateway_webhook_secret"
        placeholder={t("sms.settings.webhook_secret_placeholder")}
        type="password"
        value={s.smsGatewayWebhookConfigured ? MASK_SENTINEL : undefined}
      />
    </label>
    <Raw html={t("sms.settings.webhook_note")} />
  </SettingsSection>
);
