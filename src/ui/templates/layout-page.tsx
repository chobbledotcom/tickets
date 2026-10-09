/** The full-page shell for the admin pages that render without the admin
 * nav: the admin login page and the demo database-reset page. */
import type { Child } from "#jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";

/** Render `body` inside the site Layout under `title` as an HTML string. */
export const layoutPage = (title: string, body: Child): string =>
  String(
    <Layout family="admin" title={title}>
      {body}
    </Layout>,
  );
