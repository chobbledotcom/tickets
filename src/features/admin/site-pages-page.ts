/**
 * The site-page entity page: the shared Site-content tabbed page with an extra
 * Items tab slotted in — Edit / Items / Images / Actions. Pages are Site-gated;
 * the delete confirmation, the update POST, and every item-manager POST keep
 * their own routes in site-pages.ts, so this file owns only the GET surface.
 */

import type { EntityPage } from "#routes/admin/entity-pages.ts";
import { adminPath, adminPattern } from "#shared/admin-surface.ts";
import { getSitePageById } from "#shared/db/site-pages.ts";
import type { SitePage } from "#shared/types.ts";
import {
  sitePageEditPanel,
  sitePageItemsPanel,
} from "#templates/admin/site-pages.tsx";
import { writeFormTab } from "./entity-write-tab.ts";
import { defineSiteContentPage } from "./site-content-page.ts";
import { buildEditModel } from "./site-pages-data.ts";

/** The page's contents manager. Edit-like (it mutates the page), so it hides in
 * read-only mode alongside the Edit tab. */
const itemsTab = writeFormTab<SitePage>(
  "items",
  "entity.tab.items",
  async (page) => sitePageItemsPanel(await buildEditModel(page)),
);

/** The tabbed site-page page. */
export const sitePageEntityPage: EntityPage<SitePage> =
  defineSiteContentPage<SitePage>({
    basePath: (id) => adminPath("sitePage", { id }),
    deleteLabelKey: "site.pages.delete_submit",
    editPanel: sitePageEditPanel,
    extraTabs: [itemsTab],
    guideAnchor: "public-site",
    itemType: "page",
    load: (id) => getSitePageById(id),
    navActive: adminPattern("sitePages"),
    titleOf: (page) => page.name,
  });
