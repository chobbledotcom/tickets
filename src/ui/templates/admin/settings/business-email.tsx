/**
 * Business Email form for settings
 */

import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const BusinessEmailForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/business-email"
    description={
      <p>
        This email will be included in webhook notifications and used as the
        reply-to address for automated emails.
      </p>
    }
    id="settings-business-email"
    submitLabel="Save Business Email"
    title="Business Email"
  >
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
  </SettingsSection>
);
