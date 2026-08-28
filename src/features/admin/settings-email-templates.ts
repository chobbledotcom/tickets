/**
 * Admin email template settings routes - save custom email templates.
 * Owner-only access enforced via settingsHandler / withAuth
 */

import { MAX_EMAIL_TEMPLATE_LENGTH } from "#db/settings/constants.ts";
import { settings } from "#db/settings.ts";
import { settingsHandler } from "#routes/admin/settings-helpers.ts";
import { validateTemplate } from "#shared/email-renderer.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import type { EmailTemplateType } from "#types";

/** Handle POST /admin/settings/email-templates/:type - save custom email templates */
const validateTemplateFields = ({
  subject,
  html,
  text,
}: EmailContent): string | null => {
  for (const [name, value] of [
    ["subject", subject],
    ["html", html],
    ["text", text],
  ] as const) {
    if (value.length > MAX_EMAIL_TEMPLATE_LENGTH) {
      return `Template ${name} exceeds maximum length of ${MAX_EMAIL_TEMPLATE_LENGTH} characters`;
    }
    if (value) {
      const error = validateTemplate(value);
      if (error) return `Invalid template syntax in ${name}: ${error}`;
    }
  }
  return null;
};

export const handleEmailTemplatePost = (type: EmailTemplateType) => {
  const label = type === "confirmation" ? "Confirmation" : "Admin notification";
  return settingsHandler<EmailContent>({
    advanced: true,
    extract: (form) => ({
      html: form.getString("html"),
      subject: form.getString("subject"),
      text: form.getString("text"),
    }),
    formId: `settings-email-tpl-${type}`,
    label: `${label} email template`,
    save: async ({ subject, html, text }) => {
      await Promise.all([
        settings.update.email.template(type, "subject", subject.trim()),
        settings.update.email.template(type, "html", html.trim()),
        settings.update.email.template(type, "text", text.trim()),
      ]);
    },
    validate: validateTemplateFields,
  });
};
