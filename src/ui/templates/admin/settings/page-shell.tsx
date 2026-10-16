/**
 * Shared opener for the settings-family pages (settings, advanced settings,
 * debug). Each one is a themed admin page that always closes with the settings
 * guide footer; this shell owns that shape so each page only declares its
 * title, nav path, and body.
 */

import { t } from "#i18n";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
import type { NavActive } from "#templates/admin/nav.tsx";
import { SettingsGuideFooter } from "#templates/admin/settings/guide-footer.tsx";
import { ProseHeading } from "#templates/components/prose-heading.tsx";
import type { AdminSession, Theme } from "#types";

/** Open a settings page: pass the title (and optional nav path), then the
 * session and the site's saved theme, then the page body. The settings guide
 * footer is always appended after the body. The nav path defaults to the
 * settings page, as {@link renderAdminPageSpec}'s themed pages always did. */
export const settingsPage =
  (title: string, active?: NavActive) =>
  (session: AdminSession, theme: Theme) =>
  (body: JSX.Element): string =>
    renderAdminPageSpec({
      active: active ?? "/admin/settings",
      body: (
        <>
          {body}
          <SettingsGuideFooter />
        </>
      ),
      session,
      theme,
      title,
    });

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
