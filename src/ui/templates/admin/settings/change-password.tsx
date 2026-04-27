/**
 * Change Password form for settings
 */

import { CsrfForm, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { changePasswordFields } from "#templates/fields.ts";

export const ChangePasswordForm = (): JSX.Element => (
  <CsrfForm action="/admin/settings" id="settings-password">
    <h2>Change Password</h2>
    <p>Changing your password will log you out of all sessions.</p>
    <Raw html={renderFields(changePasswordFields)} />
    <button type="submit">Change Password</button>
  </CsrfForm>
);
