/**
 * Public API toggle form for advanced settings — exposes a JSON API for
 * listing listings, checking availability, and creating bookings.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { booleanSettingsSection } from "#templates/admin/settings/boolean-settings-section.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
/* jscpd:ignore-end */

export const PublicApiForm = booleanSettingsSection<AdvancedSettingsPageState>({
  action: "/admin/settings/show-public-api",
  description: (
    <p>
      Exposes a JSON API for listing listings, checking availability, and
      creating bookings. See the <a href="/admin/guide#api">API guide</a> for
      details.
    </p>
  ),
  fieldName: "show_public_api",
  title: t("settings.advanced.public_api"),
  value: (s) => s.showPublicApi,
});
