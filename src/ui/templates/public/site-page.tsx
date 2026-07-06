/**
 * Public template for a user-created content page (`/page/:slug`): SEO meta
 * (title from meta_title, an escaped description tag — net-new, no other page
 * emits one), the markdown body, and the page's items as a list of links
 * (dead targets render as text, never a link that 404s).
 */

import type { NavNode } from "#shared/site-pages/types.ts";
import type { SitePage } from "#shared/types.ts";
import { nodeLis } from "#templates/components/nav.tsx";
import {
  MarkdownProse,
  type PublicNavProps,
  publicSeoPage,
} from "./shared.tsx";

export const sitePagePage = (
  page: SitePage,
  nav: PublicNavProps,
  websiteTitle: string,
): string => {
  // The page's own items, straight off the model (empty when a concurrent
  // delete raced the nav reads and the page is no longer on the tree).
  const items: readonly NavNode[] = nav.pages.currentChildren;
  return publicSeoPage(
    page,
    nav,
    websiteTitle,
  )(
    <>
      <MarkdownProse markdown={page.content} />
      {items.length > 0 && <ul class="page-items">{nodeLis(items)}</ul>}
    </>,
  );
};
