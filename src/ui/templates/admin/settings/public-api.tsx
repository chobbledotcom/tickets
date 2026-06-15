/**
 * Public API toggle form for advanced settings
 */

import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const PublicApiForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/show-public-api"
    description={
      <p>
        Exposes a JSON API for listing listings, checking availability, and
        creating bookings. See the <a href="/admin/guide#api">API guide</a> for
        details.
      </p>
    }
    submitLabel="Save"
    title="Enable public API?"
  >
    <fieldset class="radios">
      <label>
        <input
          checked={s.showPublicApi === true}
          name="show_public_api"
          type="radio"
          value="true"
        />
        Yes
      </label>
      <label>
        <input
          checked={s.showPublicApi !== true}
          name="show_public_api"
          type="radio"
          value="false"
        />
        No
      </label>
    </fieldset>
  </SettingsSection>
);
