/**
 * Public template for a user-created content page (`/page/:slug`): SEO meta
 * (title from meta_title, an escaped description tag — net-new, no other page
 * emits one), the markdown body, and the page's items as a list of links
 * (dead targets render as text, never a link that 404s).
 */

import { t } from "#i18n";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { NavNode } from "#shared/site-pages/types.ts";
import type { SitePage } from "#shared/types.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import {
  FEED_DISCOVERY_TAGS,
  NodeLink,
  PublicNav,
  type PublicNavProps,
} from "./shared.tsx";

export const sitePagePage = (
  page: SitePage,
  items: readonly NavNode[],
  nav: PublicNavProps,
  websiteTitle?: string | null,
): string => {
  const base = page.meta_title || page.name;
  const title = websiteTitle ? `${base} - ${websiteTitle}` : base;
  const metaTag = page.meta_description
    ? `\n<meta name="description" content="${escapeHtml(page.meta_description)}" />`
    : "";
  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS + metaTag} title={title}>
      <PublicNav {...nav} />
      <h1>{page.name}</h1>
      {page.content && (
        <div class="prose">
          <Raw html={renderMarkdown(page.content)} />
        </div>
      )}
      {items.length > 0 && (
        <ul class="page-items">
          {items.map((node) => (
            <li>
              <NodeLink node={node} />
            </li>
          ))}
        </ul>
      )}
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
        </p>
      </footer>
    </Layout>,
  );
};
