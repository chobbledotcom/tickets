/**
 * Shared opener for the settings-family pages (settings, advanced settings,
 * debug). Each one is a themed admin page that always closes with the settings
 * guide footer; this shell owns that shape so each page only declares its
 * title, nav path, and body.
 */

import { themedAdminPage } from "#templates/admin/admin-page.tsx";
import { SettingsGuideFooter } from "#templates/admin/settings/guide-footer.tsx";

/** Open a settings page: pass the title (and optional nav path), then the
 * session and the site's saved theme, then the page body. The settings guide
 * footer is always appended after the body. Same calling shape as
 * {@link themedAdminPage}, which it wraps. */
export const settingsPage: typeof themedAdminPage =
  (title, active) => (session, theme) => (body) =>
    themedAdminPage(title, active)(session, theme)(
      <>
        {body}
        <SettingsGuideFooter />
      </>,
    );
