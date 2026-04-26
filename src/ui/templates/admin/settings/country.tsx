/**
 * Country form for settings
 */

import { COUNTRIES, type CountryData } from "#lib/countries.ts";
import { CsrfForm } from "#lib/forms.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";

export const CountryForm = (s: SettingsPageState): JSX.Element => (
  <CsrfForm action="/admin/settings/country" id="settings-country">
    <h2>Your Country</h2>
    <p>Sets your timezone, currency, and phone prefix.</p>
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
    <button type="submit">Save Country</button>
  </CsrfForm>
);
