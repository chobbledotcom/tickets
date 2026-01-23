/**
 * Base layout and common template utilities
 */

import { type Child, Raw, SafeHtml } from "#jsx/jsx-runtime.ts";

export const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

interface LayoutProps {
  title: string;
  children?: Child;
}

/**
 * Wrap content in MVP.css semantic HTML layout
 */
export const Layout = ({ title, children }: LayoutProps): SafeHtml =>
  new SafeHtml(
    "<!DOCTYPE html>" +
    (
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>{title}</title>
          <link rel="stylesheet" href="/mvp.css" />
        </head>
        <body>
          <main>
            {children}
          </main>
        </body>
      </html>
    )
  );

/**
 * Legacy function wrapper for backward compatibility
 * Note: content is expected to be pre-rendered HTML
 */
export const layout = (title: string, content: string): string =>
  String(<Layout title={title}><Raw html={content} /></Layout>);
