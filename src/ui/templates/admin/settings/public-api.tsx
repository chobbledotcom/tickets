/**
 * Public API toggle form for advanced settings
 */

import { CsrfForm } from "#shared/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";

export const PublicApiForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <CsrfForm
    action="/admin/settings/show-public-api"
    id="settings-show-public-api"
  >
    <h2>Enable public API?</h2>
    <p>
      Exposes a JSON API for listing listings, checking availability, and
      creating bookings. See the <a href="/admin/guide#api">API guide</a> for
      details.
    </p>
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
    <button type="submit">Save</button>
  </CsrfForm>
);
