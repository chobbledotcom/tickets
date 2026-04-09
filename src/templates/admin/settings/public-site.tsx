/**
 * Show Public Site form for settings
 */

import { CsrfForm } from "#lib/forms.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";

export const PublicSiteForm = (s: SettingsPageState): JSX.Element => (
  <CsrfForm
    action="/admin/settings/show-public-site"
    id="settings-show-public-site"
  >
    <h2>Show public site?</h2>
    <p>
      When enabled, the homepage will show a public website with navigation for
      Home, Events, T&amp;Cs and Contact pages.
    </p>
    <label>
      <input
        type="radio"
        name="show_public_site"
        value="true"
        checked={s.showPublicSite === true}
      />
      Yes
    </label>
    <label>
      <input
        type="radio"
        name="show_public_site"
        value="false"
        checked={s.showPublicSite !== true}
      />
      No
    </label>
    <button type="submit">Save</button>
  </CsrfForm>
);
