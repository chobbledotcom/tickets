/**
 * Site Theme form for settings
 */

import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const ThemeForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/theme"
    description={
      <p>Choose between light and dark themes for the site interface.</p>
    }
    submitLabel="Save Theme"
    title="Site Theme"
  >
    <fieldset class="radios">
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
  </SettingsSection>
);
