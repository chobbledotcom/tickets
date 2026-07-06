/**
 * The news entity page: one declarative definition of the tabbed
 * /admin/site/news/:id page, replacing the old single edit page. Mirrors the
 * shape of the listing/group entity pages.
 *
 *   Edit     — the post's fields form (name, editable slug + public link, SEO
 *              meta, snippet, markdown body)
 *   Images   — the shared per-item image panel (image_uses, item_type 'news')
 *   Actions  — danger zone: delete
 *
 * News is Site-gated (owner + editor); the delete confirmation and every POST
 * sub-action keep their own routes in news.ts, so this file owns only the GET
 * surface. A bare /admin/site/news/:id lands on the Edit tab (the first visible
 * tab), and /admin/site/news/:id/edit resolves to it too.
 */

import {
  type ActionDef,
  defineEntityPage,
  type EntityPage,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { requireSiteOr } from "#routes/auth.ts";
import { getNewsPostById } from "#shared/db/news-posts.ts";
import { isReadOnly } from "#shared/env.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import type { NewsPost } from "#shared/types.ts";
import { newsEditPanel } from "#templates/admin/news.tsx";
import { loadItemImagesPanel } from "./item-images.ts";

const basePath = (id: number): string => `/admin/site/news/${id}`;

/** The Edit tab is hidden in read-only mode (the update route bounces to
 * /read-only there), so a bare-URL default can't resolve onto an un-editable
 * form; Images additionally needs storage configured. */
const editVisible = (): boolean => !isReadOnly();
const imagesVisible = (): boolean => editVisible() && isStorageEnabled();

/** The Actions tab entries — just the delete danger zone. */
const NEWS_ACTIONS: readonly ActionDef<NewsPost>[] = [
  {
    danger: true,
    href: (post) => `${basePath(post.id)}/delete`,
    icon: "trash-2",
    labelKey: "news.delete_submit",
  },
];

const editTab: TabDef<NewsPost> = {
  labelKey: "entity.tab.edit",
  sections: [
    { kind: "custom", load: (post) => Promise.resolve(newsEditPanel(post)) },
  ],
  slug: "edit",
  visible: editVisible,
};

const imagesTab: TabDef<NewsPost> = {
  labelKey: "entity.tab.images",
  sections: [
    {
      kind: "custom",
      load: (post) => loadItemImagesPanel("news", post.id, basePath(post.id)),
    },
  ],
  slug: "images",
  visible: imagesVisible,
};

const actionsTab: TabDef<NewsPost> = {
  labelKey: "entity.tab.actions",
  sections: [
    { actions: NEWS_ACTIONS, kind: "actions", titleKey: "entity.tab.actions" },
  ],
  slug: "actions",
};

/** The tabbed news page. */
export const newsPage: EntityPage<NewsPost> = defineEntityPage({
  basePath,
  guard: requireSiteOr,
  load: (id) => getNewsPostById(id),
  navActive: "/admin/site/news",
  tabs: [editTab, imagesTab, actionsTab],
  titleOf: (post) => post.name,
});
