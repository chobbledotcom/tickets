/**
 * Country form for settings
 */

import { COUNTRIES, type CountryData } from "#shared/countries.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const CountryForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/country"
    description={<p>Sets your timezone, currency, and phone prefix.</p>}
    id="settings-country"
    submitLabel="Save Country"
    title="Your Country"
  >
    <label>
      Country
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
