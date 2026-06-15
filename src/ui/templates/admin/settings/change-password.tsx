/**
 * Change Password form for settings
 */

import { renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { changePasswordFields } from "#templates/fields.ts";

export const ChangePasswordForm = (): JSX.Element => (
  <SettingsSection
    action="/admin/settings"
    description={
      <p>Changing your password will log you out of all sessions.</p>
    }
    id="settings-password"
    submitLabel="Change Password"
    title="Change Password"
  >
    <Raw html={renderFields(changePasswordFields)} />
  </SettingsSection>
);
