/**
 * Base layout and common template utilities
 */

import { type Child, Raw, SafeHtml } from "#jsx/jsx-runtime.ts";
import { CSS_PATH, IFRAME_RESIZER_CHILD_JS_PATH, JS_PATH } from "#src/config/asset-paths.ts";
import { getTheme } from "#lib/theme.ts";

export const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

interface LayoutProps {
  title: string;
  bodyClass?: string;
  headExtra?: string;
  children?: Child;
  theme?: string;
}

/**
 * Wrap content in MVP.css semantic HTML layout
 */
export const Layout = ({ title, bodyClass, headExtra, children, theme }: LayoutProps): SafeHtml => {
  const resolvedTheme = theme ?? getTheme();
  const colorScheme = resolvedTheme === "dark" ? "dark" : "light";
  const themeStyle = `<style>html { color-scheme: ${colorScheme}; }</style>`;

  return new SafeHtml(
    "<!DOCTYPE html>" +
    (
      <html lang="en" data-theme={resolvedTheme}>
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>{title}</title>
          <link rel="stylesheet" href={CSS_PATH} />
          <Raw html={themeStyle} />
          {headExtra && <Raw html={headExtra} />}
        </head>
        <body class={bodyClass || undefined}>
          <main>
            {children}
          </main>
          {bodyClass?.includes("iframe") && <script src={IFRAME_RESIZER_CHILD_JS_PATH}></script>}
          <script src={JS_PATH} defer></script>
        </body>
      </html>
    )
  );
};

