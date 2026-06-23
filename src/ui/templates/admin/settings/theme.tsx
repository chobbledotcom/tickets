/**
 * Site Theme form for settings
 */

import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const ThemeForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/theme"
    description={<p>{t("settings.theme_hint")}</p>}
    submitLabel={t("settings.save_theme")}
    title={t("settings.theme")}
  >
    <fieldset class="radios">
      <label>
        <input
          checked={s.theme === "light"}
          name="theme"
          type="radio"
          value="light"
        />
        {t("settings.theme_light")}
      </label>
      <label>
        <input
          checked={s.theme === "dark"}
          name="theme"
          type="radio"
          value="dark"
        />
        {t("settings.theme_dark")}
      </label>
    </fieldset>
    <label class="checkbox">
      <input
        checked={s.underlineLinks}
        name="underline_links"
        type="checkbox"
        value="true"
      />{" "}
      {t("settings.underline_links")}
    </label>
    <small>{t("settings.underline_links_hint")}</small>
  </SettingsSection>
);
