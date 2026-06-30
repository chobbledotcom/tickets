/**
 * Custom CSS form for advanced settings.
 *
 * Plain textarea (not markdown): the value is served verbatim as a public
 * stylesheet from /custom.css.
 */

import { t } from "#i18n";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const CustomCssForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/custom-css"
    description={<p>{t("settings.advanced.custom_css_hint")}</p>}
    submitLabel={t("settings.advanced.save_custom_css")}
    title={t("settings.advanced.custom_css")}
  >
    <label>
      {t("settings.advanced.custom_css_label")}
      <textarea
        maxlength={MAX_TEXTAREA_LENGTH}
        name="custom_css"
        placeholder={t("settings.advanced.custom_css_placeholder")}
      >
        {s.customCss}
      </textarea>
    </label>
  </SettingsSection>
);
