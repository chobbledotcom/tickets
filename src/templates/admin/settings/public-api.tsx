/**
 * Public API toggle form for advanced settings
 */

import { CsrfForm } from "#lib/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";

export const PublicApiForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <CsrfForm
    action="/admin/settings/show-public-api"
    id="settings-show-public-api"
  >
    <h2>Enable public API?</h2>
    <p>
      Exposes a JSON API for listing events, checking availability, and creating
      bookings. See the <a href="/admin/guide#api">API guide</a> for details.
    </p>
    <label>
      <input
        type="radio"
        name="show_public_api"
        value="true"
        checked={s.showPublicApi === true}
      />
      Yes
    </label>
    <label>
      <input
        type="radio"
        name="show_public_api"
        value="false"
        checked={s.showPublicApi !== true}
      />
      No
    </label>
    <button type="submit">Save</button>
  </CsrfForm>
);
