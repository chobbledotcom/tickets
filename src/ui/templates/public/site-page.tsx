/**
 * Public template for a user-created content page (`/page/:slug`). It carries
 * the SEO meta (title from meta_title, and an escaped description tag that no
 * other page emits), the markdown body, and the page's items. The items
 * render as a list of links. Dead targets render as text, never a link that
 * 404s.
 */

import type { NavNode } from "#shared/site-pages/types.ts";
import { nodeLis } from "#templates/components/nav.tsx";
import type { SitePage } from "#types";
import { seoContentPage } from "./content-page.tsx";
import { MarkdownProse, PublicImageGallery } from "./shared.tsx";

export const sitePagePage = seoContentPage<SitePage>(
  {},
  (page, images, nav) => {
    // The page's own items, straight off the model. Empty when a concurrent
    // delete raced the nav reads and the page is no longer on the tree.
    const items: readonly NavNode[] = nav.pages.currentChildren;
    return (
      <>
        <PublicImageGallery images={images} />
        <MarkdownProse markdown={page.content} />
        {items.length > 0 && <ul class="page-items">{nodeLis(items)}</ul>}
      </>
    );
  },
);
