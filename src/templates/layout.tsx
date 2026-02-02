/**
 * Base layout and common template utilities
 */

import { type Child, SafeHtml } from "#jsx/jsx-runtime.ts";
import { CSS_PATH } from "#src/config/asset-paths.ts";

export const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

interface LayoutProps {
  title: string;
  bodyClass?: string;
  children?: Child;
}

/**
 * Wrap content in MVP.css semantic HTML layout
 */
export const Layout = ({ title, bodyClass, children }: LayoutProps): SafeHtml =>
  new SafeHtml(
    "<!DOCTYPE html>" +
    (
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>{title}</title>
          <link rel="stylesheet" href={CSS_PATH} />
        </head>
        <body class={bodyClass || undefined}>
          <main>
            {children}
          </main>
        </body>
      </html>
    )
  );

