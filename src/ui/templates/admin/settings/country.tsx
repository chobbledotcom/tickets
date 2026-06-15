/**
 * Country form for settings
 */

import { COUNTRIES, type CountryData } from "#shared/countries.ts";
import { CsrfForm } from "#shared/forms.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

export const CountryForm = (s: SettingsPageState): JSX.Element => (
  <CsrfForm action="/admin/settings/country" id="settings-country">
    <div class="prose">
      <h2>Your Country</h2>
      <p>Sets your timezone, currency, and phone prefix.</p>
    </div>
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
    <SubmitButton icon="save">Save Country</SubmitButton>
  </CsrfForm>
);
