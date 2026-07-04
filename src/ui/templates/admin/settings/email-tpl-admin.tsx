/**
 * Admin Notification Email Template form for advanced settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { emailTemplateFields } from "#templates/components/email-template-fields.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";
/* jscpd:ignore-end */

export const AdminEmailTemplateForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <SettingsSection
    action="/admin/settings/email-templates/admin"
    description={
      <p>
        Customise the notification email sent to the business email when a
        registration comes in (
        <a href="/admin/guide#email-templates">template guide</a>). Leave blank
        to use the default template.
      </p>
    }
    id="settings-email-tpl-admin"
    submitLabel={t("settings.advanced.save_admin_notification_template")}
    title={t("settings.advanced.admin_notification_email")}
  >
    {emailTemplateFields("admin")(s.adminTemplates, DEFAULT_TEMPLATES.admin)}
  </SettingsSection>
);
