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
        autocomplete="off"
        name="subject"
        placeholder={DEFAULT_TEMPLATES.admin.subject}
        type="text"
        value={s.adminTemplates.subject}
      />
    </label>
    <label>
      HTML Body
      <textarea
        data-default-tpl={DEFAULT_TEMPLATES.admin.html}
        id="admin_html"
        name="html"
        placeholder="Leave blank to use default template"
        rows="8"
      >
        {s.adminTemplates.html}
      </textarea>
    </label>
    <a data-fill-default="admin_html" href="#">
      <small>Edit default template</small>
    </a>
    <label>
      Plain Text Body
      <textarea
        data-default-tpl={DEFAULT_TEMPLATES.admin.text}
        id="admin_text"
        name="text"
        placeholder="Leave blank to use default template"
        rows="6"
      >
        {s.adminTemplates.text}
      </textarea>
    </label>
    <a data-fill-default="admin_text" href="#">
      <small>Edit default template</small>
    </a>
    <br />
    <button type="submit">Save Admin Notification Template</button>
  </CsrfForm>
);
