/**
 * Admin email settings routes - provider configuration and test send.
 * Owner-only access enforced via settingsHandler / advancedSettingsRoute.
 */

import {
  advancedSettingsRoute,
  processSecretField,
  type SecretFieldResult,
  settingsHandler,
} from "#routes/admin/settings-helpers.ts";
import { settings } from "#shared/db/settings.ts";
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
  label: "Email settings",
  log: ({ provider }) =>
    provider === "" ? "Email provider disabled" : "Email settings updated",
  save: async ({ provider, apiKey, fromAddress }) => {
    if (provider === "") {
      await settings.update.email.provider("");
      await settings.update.email.apiKey("");
      await settings.update.email.fromAddress("");
      return;
    }
    await settings.update.email.provider(provider);
    if (apiKey.action === "provided") {
      await settings.update.email.apiKey(apiKey.value);
    }
    if (fromAddress) await settings.update.email.fromAddress(fromAddress);
  },
  validate: ({ provider, fromAddress }) => {
    if (provider === "") return null;
    if (!isEmailProvider(provider)) return "Invalid email provider";
    if (fromAddress && !isValidEmail(fromAddress)) {
      return "Invalid from-address format. Please use format: name@domain.com";
    }
    return null;
  },
});

/** Handle POST /admin/settings/email/test - send test email to business email */
export const handleEmailTestPost = advancedSettingsRoute(
  async (_form, errorPage) => {
    const config = await getEmailConfig();
    if (!config) {
      return errorPage("Email not configured", 400, "settings-email");
    }
    const businessEmail = parseEmail(settings.businessEmail);
    if (!businessEmail) {
      return errorPage("No business email set", 400, "settings-email-test");
    }
    const status = await sendTestEmail(config, businessEmail);
    if (!status) {
      return errorPage(
        "Test email failed (no response)",
        502,
        "settings-email-test",
      );
    }
    if (status >= 300) {
      return errorPage(
        `Test email failed (status ${status})`,
        502,
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
