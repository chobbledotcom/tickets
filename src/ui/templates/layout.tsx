/**
 * Base layout and common template utilities
 */

import { type Child, Raw, SafeHtml } from "#jsx/jsx-runtime.ts";
import {
  CSS_PATH,
  IFRAME_RESIZER_CHILD_JS_PATH,
  JS_PATH,
} from "#shared/asset-paths.ts";
import { settings } from "#shared/db/settings.ts";
import { DEMO_BANNER, isDemoMode } from "#shared/demo.ts";
import { flashConsumed, getFlash } from "#shared/flash-context.ts";
import { Flash } from "#shared/forms.tsx";
import { getImageProxyUrl } from "#shared/storage.ts";
import type { Theme } from "#shared/types.ts";
import { renderAdminFooter } from "#templates/admin/footer.tsx";

export const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

interface LayoutProps {
  bodyClass?: string;
  children?: Child;
  headExtra?: string;
  theme?: Theme;
  title: string;
}

/**
 * Wrap content in MVP.css semantic HTML layout
 */
export const Layout = ({
  title,
  bodyClass,
  headExtra,
  children,
  theme,
}: LayoutProps): SafeHtml => {
  const resolvedTheme = theme ?? settings.theme;
  const headerImage = settings.headerImageUrl;

  return new SafeHtml(
    "<!DOCTYPE html>" +
    (
      <html
        data-theme={resolvedTheme}
        data-underline-links={settings.underlineLinks}
        lang="en"
      >
        <head>
          <meta charset="UTF-8" />
          <meta
            content="width=device-width, initial-scale=1.0"
            name="viewport"
          />
          <title>{title}</title>
          <link href={CSS_PATH} rel="stylesheet" />
          {headExtra && <Raw html={headExtra} />}
        </head>
        <body class={bodyClass || undefined}>
          <a class="skip-nav" href="#main-content">
            Skip to content
          </a>
          {isDemoMode() && <Raw html={DEMO_BANNER} />}
          <main id="main-content" tabindex="-1">
            {headerImage && (
              <img
                alt=""
                class="header-image"
                src={getImageProxyUrl(headerImage)}
              />
            )}
            {/* Backstop: render the request's flash here unless the page already
                did (a targeted CsrfForm or an inline banner marked it consumed).
                Evaluated after `children`, so the consumed flag is already set.
                This is why no page needs to thread flash.success/error to be
                shown — placing it once, structurally, removes the whole class of
                "handler set the cookie but the page dropped it" bug. */}
            {!flashConsumed() && (
              <Flash
                error={getFlash().error}
                info={getFlash().info}
                success={getFlash().success}
              />
            )}
            {children}
          </main>
          {bodyClass?.includes("iframe") && (
            <script src={IFRAME_RESIZER_CHILD_JS_PATH}></script>
          )}
          <script defer src={JS_PATH}></script>
          <Raw html={renderAdminFooter()} />
        </body>
      </html>
    ),
  );
};
