/**
 * Business Email form for settings
 */

import { CsrfForm } from "#shared/forms.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

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
        autocomplete="email"
        name="business_email"
        placeholder="contact@example.com"
        type="email"
        value={s.businessEmail}
      />
    </label>
    <SubmitButton icon="save">Save Business Email</SubmitButton>
  </CsrfForm>
);
