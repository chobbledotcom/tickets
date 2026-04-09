/**
 * Business Email form for settings
 */

import { CsrfForm } from "#lib/forms.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";

export const BusinessEmailForm = (s: SettingsPageState): JSX.Element => (
  <CsrfForm
    action="/admin/settings/business-email"
    id="settings-business-email"
  >
    <h2>Business Email</h2>
    <p>
      This email will be included in webhook notifications and used as the
      reply-to address for automated emails.
    </p>
    <label>
      Business Email
      <input
        type="email"
        name="business_email"
        placeholder="contact@example.com"
        value={s.businessEmail}
        autocomplete="email"
      />
    </label>
    <button type="submit">Save Business Email</button>
  </CsrfForm>
);
