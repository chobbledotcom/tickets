/**
 * Site Theme form for settings
 */

import { CsrfForm } from "#lib/forms.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";

export const ThemeForm = (s: SettingsPageState): JSX.Element => (
  <CsrfForm action="/admin/settings/theme" id="settings-theme">
    <h2>Site Theme</h2>
    <p>Choose between light and dark themes for the site interface.</p>
    <label>
      <input
        type="radio"
        name="theme"
        value="light"
        checked={s.theme === "light"}
      />
      Light
    </label>
    <label>
      <input
        type="radio"
        name="theme"
        value="dark"
        checked={s.theme === "dark"}
      />
      Dark
    </label>
    <button type="submit">Save Theme</button>
  </CsrfForm>
);
