/**
 * Site Theme form for settings
 */

import { CsrfForm } from "#shared/forms.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";

export const ThemeForm = (s: SettingsPageState): JSX.Element => (
  <CsrfForm action="/admin/settings/theme" id="settings-theme">
    <h2>Site Theme</h2>
    <p>Choose between light and dark themes for the site interface.</p>
    <fieldset class="radio-group">
      <label>
        <input
          checked={s.theme === "light"}
          name="theme"
          type="radio"
          value="light"
        />
        Light
      </label>
      <label>
        <input
          checked={s.theme === "dark"}
          name="theme"
          type="radio"
          value="dark"
        />
        Dark
      </label>
    </fieldset>
    <button type="submit">Save Theme</button>
  </CsrfForm>
);
