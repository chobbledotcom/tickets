/**
 * Admin SMS gateway settings route. Owner-only (enforced via settingsHandler).
 *
 * Saves the SMS Gate credentials and the end-to-end passphrase. Password and
 * passphrase are masked secrets: a submitted sentinel leaves the stored value
 * unchanged, an empty value clears it.
 */

import {
  processSecretField,
  type SecretFieldResult,
  settingsHandler,
} from "#routes/admin/settings-helpers.ts";
import { settings } from "#shared/db/settings.ts";

type SmsGatewayFormData = {
  username: string;
  baseUrl: string;
  password: SecretFieldResult;
  passphrase: SecretFieldResult;
  webhookSecret: SecretFieldResult;
};

/** Accept only http(s) URLs (or empty). */
const isHttpUrl = (raw: string): boolean => {
  try {
    return ["http:", "https:"].includes(new URL(raw).protocol);
  } catch {
    return false;
  }
};

/** Apply a masked-secret field: provided → set, cleared → empty, unchanged → skip. */
const saveSecret = async (
  field: SecretFieldResult,
  update: (value: string) => Promise<void>,
): Promise<void> => {
  if (field.action === "provided") return update(field.value);
  if (field.action === "cleared") return update("");
};

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
    await saveSecret(password, settings.update.smsGatewayPassword);
    await saveSecret(passphrase, settings.update.smsGatewayPassphrase);
    await saveSecret(webhookSecret, settings.update.smsGatewayWebhookSecret);
  },
  validate: ({ baseUrl }) =>
    baseUrl && !isHttpUrl(baseUrl) ? "Invalid server URL" : null,
});
