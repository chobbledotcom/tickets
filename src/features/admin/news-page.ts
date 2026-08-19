/**
 * The news entity page: the shared Site-content tabbed page (Edit / Images /
 * Actions) bound to a news post. News is Site-gated; the delete confirmation
 * and every POST sub-action keep their own routes in news.ts, so this file owns
 * only the GET surface. A bare /admin/site/news/:id lands on the Edit tab, and
 * /admin/site/news/:id/edit resolves to it too.
 */

import type { EntityPage } from "#routes/admin/entity-pages.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { getNewsPostById } from "#shared/db/news-posts.ts";
import type { NewsPost } from "#shared/types.ts";
import { newsEditPanel } from "#templates/admin/news.tsx";
import { defineSiteContentPage } from "./site-content-page.ts";

/** The tabbed news page. */
export const newsPage: EntityPage<NewsPost> = defineSiteContentPage<NewsPost>({
  deleteLabelKey: "news.delete_submit",
  destination: "newsPost",
  editPanel: newsEditPanel,
  guideAnchor: "public-site",
  itemType: "news",
  load: (id) => getNewsPostById(id),
  navActive: adminPattern("news"),
  titleOf: (post) => post.name,
});
