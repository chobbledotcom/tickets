import { MAX_EMAIL_TEMPLATE_LENGTH } from "#db/settings/constants.ts";
import { t } from "#i18n";
import { effectiveMaxLength, type Field } from "#shared/forms/field.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  getSquareWebhookFields,
  getStripeKeyFields,
  squareAccessTokenFields,
  sumupFields,
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

/** The run sheet's two templates: the day heading and the day body. */
export const runSheetTemplateSettingsFields = (): readonly Field[] => [
  {
    label: t("settings.run_sheet.heading"),
    maxlength: MAX_TEXTAREA_LENGTH,
    name: "heading",
    type: "textarea",
  },
  {
    label: t("settings.run_sheet.body"),
    maxlength: MAX_TEXTAREA_LENGTH,
    name: "body",
    type: "textarea",
  },
];

/** Custom settings layouts use the same fields as their POST routes. */
export const CUSTOM_SETTINGS_FIELDS: Record<string, () => readonly Field[]> = {
  "settings-apple-wallet": () => [
    text("appleWalletPassTypeId", "settings.advanced.apple_pass_type_id"),
    text("appleWalletTeamId", "settings.advanced.apple_team_id"),
    secret(
      "appleWalletSigningCert",
      "settings.advanced.apple_signing_cert",
      "textarea",
    ),
    secret(
      "appleWalletSigningKey",
      "settings.advanced.apple_signing_key",
      "textarea",
    ),
    secret(
      "appleWalletWwdrCert",
      "settings.advanced.apple_wwdr_cert",
      "textarea",
    ),
  ],
  "settings-custom-domain": () => [
    text("customDomain", "settings.advanced.domain_label"),
  ],
  "settings-email": () => [
    secret("emailApiKey", "settings.advanced.api_key"),
    text("emailFromAddress", "settings.advanced.from_address", "email"),
  ],
  "settings-google-wallet": () => [
    text("googleWalletIssuerId", "settings.advanced.google_issuer_id"),
    text(
      "googleWalletServiceAccountEmail",
      "settings.advanced.google_service_email",
      "email",
    ),
    secret(
      "googleWalletServiceAccountKey",
      "settings.advanced.google_service_key",
      "textarea",
    ),
  ],
  "settings-host-subdomain": () => [
    text("subdomain", "settings.subdomain.subdomain_label"),
  ],
  "settings-logistics-run-sheet": runSheetTemplateSettingsFields,
  "settings-sms-gateway": () => [
    text("smsGatewayUsername", "sms.settings.username"),
    text("smsGatewayBaseUrl", "sms.settings.base_url", "url"),
    secret("smsGatewayPassword", "sms.settings.password"),
    secret("smsGatewayPassphrase", "sms.settings.passphrase"),
    secret("smsGatewayWebhookSecret", "sms.settings.webhook_secret"),
  ],
  "settings-square": squareAccessTokenFields,
  "settings-square-webhook": getSquareWebhookFields,
  "settings-stripe": getStripeKeyFields,
  "settings-sumup": sumupFields,
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
