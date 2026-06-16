/**
 * Country form for settings
 */

import { t } from "#i18n";
import { COUNTRIES, type CountryData } from "#shared/countries.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const CountryForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/country"
    description={<p>{t("setup.country_hint")}</p>}
    submitLabel={t("settings.save_country")}
    title={t("setup.country_label")}
  >
    <label>
      {t("settings.country_label")}
      <select name="country" required>
        {Object.entries(COUNTRIES).map(
          ([code, data]: [string, CountryData]) => (
            <option selected={code === s.country} value={code}>
              {data.name} ({data.currency}, +{data.phonePrefix})
            </option>
          ),
        )}
      </select>
    </label>
  </SettingsSection>
);
