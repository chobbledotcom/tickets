/**
 * Public API toggle form for advanced settings
 */

import { CsrfForm } from "#shared/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

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
    <fieldset class="radio-group">
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
    <SubmitButton icon="save">Save</SubmitButton>
  </CsrfForm>
);
