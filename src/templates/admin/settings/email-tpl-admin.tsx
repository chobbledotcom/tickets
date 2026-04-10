/**
 * Admin Notification Email Template form for advanced settings
 */

import { CsrfForm } from "#lib/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { DEFAULT_TEMPLATES } from "#templates/email/defaults.ts";

export const AdminEmailTemplateForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <CsrfForm
    action="/admin/settings/email-templates/admin"
    id="settings-email-tpl-admin"
  >
    <h2>Admin Notification Email Template</h2>
    <p>
      Customise the notification email sent to the business email when a
      registration comes in (
      <a href="/admin/guide#email-templates">template guide</a>). Leave blank to
      use the default template.
    </p>
    <label>
      Subject
      <input
        type="text"
        name="subject"
        placeholder={DEFAULT_TEMPLATES.admin.subject}
        value={s.adminTemplates.subject}
        autocomplete="off"
      />
    </label>
    <label>
      HTML Body
      <textarea
        id="admin_html"
        name="html"
        rows="8"
        placeholder="Leave blank to use default template"
        data-default-tpl={DEFAULT_TEMPLATES.admin.html}
      >
        {s.adminTemplates.html}
      </textarea>
    </label>
    <a href="#" data-fill-default="admin_html">
      <small>Edit default template</small>
    </a>
    <label>
      Plain Text Body
      <textarea
        id="admin_text"
        name="text"
        rows="6"
        placeholder="Leave blank to use default template"
        data-default-tpl={DEFAULT_TEMPLATES.admin.text}
      >
        {s.adminTemplates.text}
      </textarea>
    </label>
    <a href="#" data-fill-default="admin_text">
      <small>Edit default template</small>
    </a>
    <br />
    <button type="submit">Save Admin Notification Template</button>
  </CsrfForm>
);
