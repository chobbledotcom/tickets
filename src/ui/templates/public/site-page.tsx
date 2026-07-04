/**
 * Public template for a user-created content page (`/page/:slug`): SEO meta
 * (title from meta_title, an escaped description tag — net-new, no other page
 * emits one), the markdown body, and the page's items as a list of links
 * (dead targets render as text, never a link that 404s).
 */

import type { NavNode } from "#shared/site-pages/types.ts";
import type { SitePage } from "#shared/types.ts";
import { nodeLis } from "#templates/components/nav.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import {
  FEED_DISCOVERY_TAGS,
  LoginFooter,
  MarkdownProse,
  PublicNav,
  type PublicNavProps,
} from "./shared.tsx";

export const sitePagePage = (
  page: SitePage,
  nav: PublicNavProps,
  websiteTitle: string,
): string => {
  // The page's own items, straight off the model (empty when a concurrent
  // delete raced the nav reads and the page is no longer on the tree).
  const items: readonly NavNode[] = nav.pages.currentChildren;
  const base = page.meta_title || page.name;
  const title = websiteTitle ? `${base} - ${websiteTitle}` : base;
  const metaTag = page.meta_description
    ? `\n<meta name="description" content="${escapeHtml(page.meta_description)}" />`
    : "";
  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS + metaTag} title={title}>
      <PublicNav {...nav} />
      <h1>{page.name}</h1>
      <MarkdownProse markdown={page.content} />
      {items.length > 0 && <ul class="page-items">{nodeLis(items)}</ul>}
      <LoginFooter />
    </Layout>,
  );
};
