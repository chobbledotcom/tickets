/**
 * Show Public Site form for settings
 */

import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const PublicSiteForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/show-public-site"
    description={
      <p>
        When enabled, the homepage will show a public website with navigation
        for Home, Listings, T&amp;Cs and Contact pages.
      </p>
    }
    id="settings-show-public-site"
    submitLabel="Save"
    title="Show public site?"
  >
    <fieldset class="radios">
      <label>
        <input
          checked={s.showPublicSite === true}
          name="show_public_site"
          type="radio"
          value="true"
        />
        Yes
      </label>
      <label>
        <input
          checked={s.showPublicSite !== true}
          name="show_public_site"
          type="radio"
          value="false"
        />
        No
      </label>
    </fieldset>
  </SettingsSection>
);
