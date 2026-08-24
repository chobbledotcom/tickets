/**
 * Admin email settings routes - provider configuration and test send.
 * Owner-only access enforced via settingsHandler / advancedSettingsRoute.
 */

import { settings } from "#db/settings.ts";
import { t } from "#i18n";
/* jscpd:ignore-start */
import {
  advancedSettingsRoute,
  processSecretField,
  type SecretFieldResult,
  saveSecret,
  settingsHandler,
} from "#routes/admin/settings-helpers.ts";
/* jscpd:ignore-end */
import {
  getEmailConfig,
  isEmailProvider,
  sendTestEmail,
} from "#shared/email.ts";
import { ok } from "#shared/response.ts";
import { isValidEmail, parseEmail } from "#shared/validation/email.ts";

/** Handle POST /admin/settings/email - owner only */
type EmailFormData = {
  provider: string;
  apiKey: SecretFieldResult;
  fromAddress: string;
};

export const handleEmailPost = settingsHandler<EmailFormData>({
  advanced: true,
  extract: (form) => ({
    apiKey: processSecretField(form, "email_api_key"),
    fromAddress: form.getString("email_from_address"),
    provider: form.getString("email_provider"),
  }),
  formId: "settings-email",
  log: ({ provider }) =>
    provider === ""
      ? t("success.email_provider_disabled")
      : t("success.email_settings_updated"),
  save: async ({ provider, apiKey, fromAddress }) => {
    if (provider === "") {
      await settings.update.email.provider("");
      await settings.update.email.apiKey("");
      await settings.update.email.fromAddress("");
      return;
    }
    await settings.update.email.provider(provider);
    await saveSecret(apiKey, settings.update.email.apiKey);
    if (fromAddress) await settings.update.email.fromAddress(fromAddress);
  },
  validate: ({ provider, fromAddress }) => {
    if (provider === "") return null;
    if (!isEmailProvider(provider)) return t("error.invalid_email_provider");
    if (fromAddress && !isValidEmail(fromAddress)) {
      return t("error.from_address_format");
    }
    return null;
  },
});

/** Handle POST /admin/settings/email/test - send test email to business email */
export const handleEmailTestPost = advancedSettingsRoute(
  async (_form, errorPage) => {
    const config = await getEmailConfig();
    if (!config) {
      return errorPage(t("error.email_not_configured"), "settings-email");
    }
    const businessEmail = parseEmail(settings.businessEmail);
    if (!businessEmail) {
      return errorPage(t("error.no_business_email"), "settings-email-test");
    }
    const status = await sendTestEmail(config, businessEmail);
    if (!status) {
      return errorPage(
        t("error.test_email_no_response"),
        "settings-email-test",
      );
    }
    if (status >= 300) {
      return errorPage(
        `Test email failed (status ${status})`,
        "settings-email-test",
      );
    }
    return ok(
      "/admin/settings-advanced",
      `Test email sent (status ${status})`,
      { formId: "settings-email-test" },
    );
  },
);
