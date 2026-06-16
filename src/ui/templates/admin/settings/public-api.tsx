/**
 * Public API toggle form for advanced settings
 */

import { t } from "#i18n";
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
    submitLabel={t("common.save")}
    title={t("settings.advanced.public_api")}
  >
    <fieldset class="radios">
      <label>
        <input
          checked={s.showPublicApi === true}
          name="show_public_api"
          type="radio"
          value="true"
        />
        {t("common.yes")}
      </label>
      <label>
        <input
          checked={s.showPublicApi !== true}
          name="show_public_api"
          type="radio"
          value="false"
        />
        {t("common.no")}
      </label>
    </fieldset>
  </SettingsSection>
);
