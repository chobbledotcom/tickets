/** The full-page shell shared by the standalone (non-admin) pages: `body`
 * rendered inside the site `Layout` under `title`, serialized to a string. */

import type { Child } from "#jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";

/** Render `body` inside the site Layout under `title` as an HTML string. */
export const layoutPage = (title: string, body: Child): string =>
  String(<Layout title={title}>{body}</Layout>);
