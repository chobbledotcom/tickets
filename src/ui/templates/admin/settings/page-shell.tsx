/**
 * Shared opener for the settings-family pages (settings, advanced settings,
 * debug). Each one is a themed admin page that always closes with the settings
 * guide footer; this shell owns that shape so each page only declares its
 * title, nav path, and body.
 */

import { t } from "#i18n";
import { themedAdminPage } from "#templates/admin/admin-page.tsx";
import { SettingsGuideFooter } from "#templates/admin/settings/guide-footer.tsx";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
import type { AdminSession, Theme } from "#types";

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

/** A settings page that opens with a heading and an intro paragraph, then
 * the caller's own sections. Same calling shape as {@link settingsPage}. */
export const settingsArticlePage =
  (
    titleKey: string,
    headingKey: string,
    introKey: string,
    path: string,
  ): ((session: AdminSession, theme: Theme) => (body: JSX.Element) => string) =>
  (session, theme) =>
  (body) =>
    settingsPage(t(titleKey), path)(session, theme)(
      <>
        <ProseHeading heading={t(headingKey)}>
          <p>{t(introKey)}</p>
        </ProseHeading>
        {body}
      </>,
    );
