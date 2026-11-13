/**
 * The news entity page: the shared Site-content tabbed page (Edit / Images /
 * Actions) bound to a news post. News is Site-gated. The delete confirmation
 * and every POST sub-action keep their own routes in news.ts, so this file owns
 * only the GET surface. A bare /admin/site/news/:id lands on the Edit tab, and
 * /admin/site/news/:id/edit resolves to it too.
 */

import { getNewsPostById } from "#db/news-posts.ts";
import type { EditEntityPage } from "#routes/admin/entity-write-tab.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { newsRecord } from "#shared/records/news.ts";
import { recordPageIds } from "#shared/rest/record.ts";
import { newsEditPanel } from "#templates/admin/news.tsx";
import type { NewsPost } from "#types";
import { defineSiteContentPage } from "./site-content-page.ts";

/** The tabbed news page. */
export const newsPage: EditEntityPage<NewsPost> =
  defineSiteContentPage<NewsPost>({
    ...recordPageIds(newsRecord),
    deleteLabelKey: "news.delete_submit",
    editPanel: newsEditPanel,
    itemType: "news",
    load: (id) => getNewsPostById(id),
    navActive: adminPattern("news"),
  });
