import { MAX_EMAIL_TEMPLATE_LENGTH } from "#db/settings/constants.ts";
import { t } from "#i18n";
import { effectiveMaxLength, type Field } from "#shared/forms/field.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  getSquareAccessTokenFields,
  getSquareWebhookFields,
  getStripeKeyFields,
  getSumupFields,
} from "#templates/fields/admin.ts";

const text = (
  name: string,
  label: string,
  type: "text" | "email" | "url" = "text",
): Field => ({ label: t(label), name, type });
const secret = (
  name: string,
  label: string,
  type: "password" | "textarea" = "password",
): Field => ({
  label: t(label),
  maxlength: type === "textarea" ? MAX_TEXTAREA_LENGTH : MAX_INPUT_LENGTH,
  name,
  type,
});

/** Custom settings layouts use the same fields as their POST routes. */
export const CUSTOM_SETTINGS_FIELDS: Record<string, () => readonly Field[]> = {
  "settings-apple-wallet": () => [
    text("apple_wallet_pass_type_id", "settings.advanced.apple_pass_type_id"),
    text("apple_wallet_team_id", "settings.advanced.apple_team_id"),
    secret(
      "apple_wallet_signing_cert",
      "settings.advanced.apple_signing_cert",
      "textarea",
    ),
    secret(
      "apple_wallet_signing_key",
      "settings.advanced.apple_signing_key",
      "textarea",
    ),
    secret(
      "apple_wallet_wwdr_cert",
      "settings.advanced.apple_wwdr_cert",
      "textarea",
    ),
  ],
  "settings-custom-domain": () => [
    text("custom_domain", "settings.advanced.domain_label"),
  ],
  "settings-email": () => [
    secret("email_api_key", "settings.advanced.api_key"),
    text("email_from_address", "settings.advanced.from_address", "email"),
  ],
  "settings-google-wallet": () => [
    text("google_wallet_issuer_id", "settings.advanced.google_issuer_id"),
    text(
      "google_wallet_service_account_email",
      "settings.advanced.google_service_email",
      "email",
    ),
    secret(
      "google_wallet_service_account_key",
      "settings.advanced.google_service_key",
      "textarea",
    ),
  ],
  "settings-host-subdomain": () => [
    text("subdomain", "settings.subdomain.subdomain_label"),
  ],
  "settings-sms-gateway": () => [
    text("sms_gateway_username", "sms.settings.username"),
    text("sms_gateway_base_url", "sms.settings.base_url", "url"),
    secret("sms_gateway_password", "sms.settings.password"),
    secret("sms_gateway_passphrase", "sms.settings.passphrase"),
    secret("sms_gateway_webhook_secret", "sms.settings.webhook_secret"),
  ],
  "settings-square": getSquareAccessTokenFields,
  "settings-square-webhook": getSquareWebhookFields,
  "settings-stripe": getStripeKeyFields,
  "settings-sumup": getSumupFields,
};

export const emailTemplateSettingsFields = (): readonly Field[] => [
  text("subject", "settings.advanced.subject"),
  ...(["html", "text"] as const).map(
    (name): Field => ({
      label: t(
        name === "html"
          ? "settings.advanced.html_body"
          : "settings.advanced.plain_text_body",
      ),
      maxlength: MAX_EMAIL_TEMPLATE_LENGTH,
      name,
      type: "textarea",
    }),
  ),
];

export const settingsFieldAttributes = (
  fields: readonly Field[],
  name: string,
): { name: string; maxlength: number | undefined } => {
  const field = fields.find((field) => field.name === name);
  if (!field) throw new Error(`Settings field does not exist: ${name}`);
  return { maxlength: effectiveMaxLength(field), name };
};
