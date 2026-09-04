/**
 * Base layout and common template utilities
 */

import { settings } from "#db/settings.ts";
import { type Child, Raw, SafeHtml } from "#jsx/jsx-runtime.ts";
import {
  CSS_PATH,
  IFRAME_RESIZER_CHILD_JS_PATH,
  JS_PATH,
} from "#shared/asset-paths.ts";
import { demoBanner, isDemoMode } from "#shared/demo/mode.ts";
import { flashConsumed } from "#shared/flash-context.ts";
import { requestFlash } from "#shared/forms/flash.tsx";
import { getIframeMode } from "#shared/iframe.ts";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import { renderAdminFooter } from "#templates/admin/footer.tsx";
import { PageRegions } from "#templates/components/page-structure.tsx";
import type { Theme } from "#types";

interface LayoutProps {
  /** Page parts that must stay directly inside main, such as the navigation
   * sidebar and its notices. */
  beforeContent?: Child;
  bodyClass?: string | undefined;
  children?: Child;
  /** Stable page identity/custom-CSS hook added to the content region stack. */
  contentClassName?: string | undefined;
  headExtra?: string | undefined;
  theme?: Theme;
  title: string;
}

/**
 * Wrap content in MVP.css semantic HTML layout
 */
export const Layout = ({
  title,
  beforeContent,
  bodyClass,
  headExtra,
  children,
  contentClassName,
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
          {/* Operator-supplied custom CSS, served from the cached /custom.css
              route. Cache-busted by the settings version (bumped on every
              settings write) so the immutable response refreshes after an edit
              without reading the setting on every render. */}
          <link href={`/custom.css?v=${settings.version}`} rel="stylesheet" />
          {headExtra && <Raw html={headExtra} />}
        </head>
        <body class={bodyClass || undefined}>
          <a class="skip-nav" href="#main-content">
            Skip to content
          </a>
          {isDemoMode() && <Raw html={demoBanner()} />}
          <main id="main-content" tabindex="-1">
            {/* No header image in iframe embed mode: the host page already
                carries its own branding, and the image request would only
                duplicate it. */}
            {headerImage && !getIframeMode() && (
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
            {!flashConsumed() && requestFlash()}
            {beforeContent}
            <PageRegions className={contentClassName}>{children}</PageRegions>
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
