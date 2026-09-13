/**
 * Admin SMS gateway settings route. Owner-only (enforced via settingsHandler).
 *
 * Saves the SMS Gate credentials and the end-to-end passphrase. Password and
 * passphrase are masked secrets: a submitted sentinel leaves the stored value
 * unchanged, an empty value clears it.
 */

import { settings } from "#db/settings.ts";
import { t } from "#i18n";
/* jscpd:ignore-start */
import {
  processSecretField,
  type SecretFieldResult,
  saveSecret,
  settingsHandler,
} from "#routes/admin/settings-helpers.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { SMS_PASSPHRASE_MIN_LENGTH } from "#shared/sms/e2e.ts";
import { validateSafeServerFetchUrl } from "#shared/url-safety.ts";

/* jscpd:ignore-end */

type SmsGatewayFormData = {
  username: string;
  baseUrl: string;
  password: SecretFieldResult;
  passphrase: SecretFieldResult;
  webhookSecret: SecretFieldResult;
};

/** Whether a value is over the input cap, with the length refusal if so. The
 *  login-password exception does not apply here: these fields choose a new
 *  secret, they never re-enter one an older site already stored. */
const overLong = (value: string, labelKey: string): string | null =>
  value.length > MAX_INPUT_LENGTH
    ? t("fields.validation.max_length", {
        label: t(labelKey),
        max: MAX_INPUT_LENGTH,
      })
    : null;

/** A provided secret past the cap (stored secrets never re-validate). */
const secretOverLong = (
  secret: SecretFieldResult,
  labelKey: string,
): string | null =>
  secret.action === "provided" ? overLong(secret.value, labelKey) : null;

export const handleSmsGatewayPost = settingsHandler<SmsGatewayFormData>({
  advanced: true,
  extract: (form) => ({
    baseUrl: form.getString("sms_gateway_base_url").trim(),
    passphrase: processSecretField(form, "sms_gateway_passphrase"),
    password: processSecretField(form, "sms_gateway_password"),
    username: form.getString("sms_gateway_username").trim(),
    webhookSecret: processSecretField(form, "sms_gateway_webhook_secret"),
  }),
  formId: "settings-sms-gateway",
  label: "SMS gateway settings",
  save: async ({ username, baseUrl, password, passphrase, webhookSecret }) => {
    await settings.update.smsGatewayUsername(username);
    await settings.update.smsGatewayBaseUrl(baseUrl);
    const clearable = { clearable: true };
    await saveSecret(password, settings.update.smsGatewayPassword, clearable);
    await saveSecret(
      passphrase,
      settings.update.smsGatewayPassphrase,
      clearable,
    );
    await saveSecret(
      webhookSecret,
      settings.update.smsGatewayWebhookSecret,
      clearable,
    );
  },
  validate: ({ baseUrl, passphrase, username, password, webhookSecret }) => {
    const baseUrlError = validateSafeServerFetchUrl(
      baseUrl,
      "Invalid server URL",
    );
    if (baseUrlError) return baseUrlError;
    if (
      passphrase.action === "provided" &&
      passphrase.value.length < SMS_PASSPHRASE_MIN_LENGTH
    ) {
      return `End-to-end passphrase must be at least ${SMS_PASSPHRASE_MIN_LENGTH} characters`;
    }
    return (
      overLong(username, "sms.settings.username") ??
      overLong(baseUrl, "sms.settings.base_url") ??
      secretOverLong(password, "sms.settings.password") ??
      secretOverLong(passphrase, "sms.settings.passphrase") ??
      secretOverLong(webhookSecret, "sms.settings.webhook_secret")
    );
  },
});
