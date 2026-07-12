/**
 * Site Theme form for settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { SettingsCheckbox } from "#templates/admin/settings/settings-checkbox.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { RadioOption } from "#templates/components/radio-option.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
/* jscpd:ignore-end */

export const ThemeForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/theme"
    description={<p>{t("settings.theme_hint")}</p>}
    submitLabel={t("settings.save_theme")}
    title={t("settings.theme")}
  >
    <fieldset class="radios">
      <RadioOption checked={s.theme === "light"} name="theme" value="light">
        {t("settings.theme_light")}
      </RadioOption>
      <RadioOption checked={s.theme === "dark"} name="theme" value="dark">
        {t("settings.theme_dark")}
      </RadioOption>
    </fieldset>
    <SettingsCheckbox
      checked={s.underlineLinks}
      label={t("settings.underline_links")}
      labelClass="checkbox"
      name="underline_links"
    />
    <small>{t("settings.underline_links_hint")}</small>
  </SettingsSection>
);
