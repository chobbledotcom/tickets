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

export const baseStyles = `
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
  h1 { color: #333; }
  .form-group { margin-bottom: 1rem; }
  label { display: block; margin-bottom: 0.5rem; font-weight: 500; }
  input, textarea { padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; width: 100%; box-sizing: border-box; }
  button { background: #0066cc; color: white; padding: 0.5rem 1.5rem; font-size: 1rem; border: none; border-radius: 4px; cursor: pointer; }
  button:hover { background: #0055aa; }
  .error { color: #cc0000; background: #ffeeee; padding: 1rem; border-radius: 4px; margin-bottom: 1rem; }
  .success { color: #006600; background: #eeffee; padding: 1rem; border-radius: 4px; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #ddd; }
  th { background: #f5f5f5; }
  a { color: #0066cc; }
`;

interface LayoutProps {
  title: string;
  children?: Child;
}

/**
 * Wrap content in basic HTML layout
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
          <style><Raw html={baseStyles} /></style>
        </head>
        <body>
          {children}
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
