/**
 * Admin Notification Email Template form for advanced settings
 */

import { t } from "#i18n";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";

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
    <label>
      {t("settings.advanced.subject")}
      <input
        autocomplete="off"
        name="subject"
        placeholder={DEFAULT_TEMPLATES.admin.subject}
        type="text"
        value={s.adminTemplates.subject}
      />
    </label>
    <label>
      {t("settings.advanced.html_body")}
      <textarea
        data-default-tpl={DEFAULT_TEMPLATES.admin.html}
        id="admin_html"
        name="html"
        placeholder={t("settings.advanced.leave_blank_default")}
        rows="8"
      >
        {s.adminTemplates.html}
      </textarea>
    </label>
    <a data-fill-default="admin_html" href="#">
      <small>{t("settings.advanced.edit_default_template")}</small>
    </a>
    <label>
      {t("settings.advanced.plain_text_body")}
      <textarea
        data-default-tpl={DEFAULT_TEMPLATES.admin.text}
        id="admin_text"
        name="text"
        placeholder={t("settings.advanced.leave_blank_default")}
        rows="6"
      >
        {s.adminTemplates.text}
      </textarea>
    </label>
    <a data-fill-default="admin_text" href="#">
      <small>{t("settings.advanced.edit_default_template")}</small>
    </a>
    <br />
  </SettingsSection>
);
