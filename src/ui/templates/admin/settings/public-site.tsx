/**
 * Show Public Site form for settings — a single yes/no toggle declaring
 * whether the public homepage is rendered.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { booleanSettingsSection } from "#templates/admin/settings/boolean-settings-section.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
/* jscpd:ignore-end */

export const PublicSiteForm = booleanSettingsSection<SettingsPageState>({
  action: "/admin/settings/show-public-site",
  description: (
    <p>
      When enabled, the homepage will show a public website with navigation for
      Home, Listings, T&amp;Cs and Contact pages.
    </p>
  ),
  fieldName: "show_public_site",
  title: t("settings.show_public_site"),
  value: (s) => s.showPublicSite,
});
