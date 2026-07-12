/**
 * Site Theme form for settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { RadioOption } from "#templates/components/radio-option.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
/* jscpd:ignore-end */

/** A checkbox that posts `true` when ticked, with its label text beside it.
 * `labelClass` styles the wrapping label (omitted for an unstyled label). */
export const SettingsCheckbox = ({
  checked,
  name,
  label,
  labelClass,
}: {
  checked: boolean;
  name: string;
  label: string;
  labelClass?: string;
}): JSX.Element => (
  <label class={labelClass}>
    <input checked={checked} name={name} type="checkbox" value="true" /> {label}
  </label>
);

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
