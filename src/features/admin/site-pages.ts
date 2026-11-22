import { records } from "#db/record-table.ts";
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { imageOrderRoutes } from "./item-images.ts";

/**
 * Admin CRUD for user-created content Pages, under Site → Pages. Owner +
 * editor (SITE_FORM / requireSiteOr). The routes are hand-wired: create must
 * assign a root sort_order, and root reordering is bounded to roots. The
 * edit page carries an item manager the CRUD factory does not model. All the
 * tree logic (forest, eligibility, reorder neighbour) flows through the pure
 * `site-pages/core`. The read models live in `site-pages-data.ts`, and the
 * edit page itself is the shared tabbed entity page (Edit / Items / Images /
 * Actions) in `site-pages-page.ts`. This file owns the POST sub-actions and
 * route wiring.
 */

import { getNonStandaloneChildIds } from "#db/listing-parents.ts";
import { getListingOfferFlags } from "#db/listings/catalog.ts";
import { readExists } from "#db/read.ts";
import {
  addPageItem,
  getItemsForPage,
  removePageItem,
  sitePageItemOrder,
} from "#db/site-page-items.ts";
import { type SitePageWriteInput, sitePageOrder } from "#db/site-pages.ts";
import { t } from "#i18n";
import { formGuard, SITE_FORM } from "#routes/auth.ts";
import {
  createEntityHandler,
  createIdEntityHandler,
  throughParent,
} from "#routes/entity.ts";
import { errorRedirect } from "#routes/response.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { idRows, orderedListRoutes } from "#shared/ordered-list-routes.ts";
import { ORDERED_LISTS } from "#shared/ordered-lists.ts";
import { sitePageRecord } from "#shared/records/site-pages.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import { eligibleChildPages } from "#shared/site-pages/core.ts";
import { loadPageForest } from "#shared/site-pages/load.ts";
import type { SitePageItemTarget } from "#shared/site-pages/target.ts";
import { normalizeSlug } from "#shared/slug.ts";
import {
  adminSitePageDeletePage,
  adminSitePageNewPage,
  adminSitePagesListPage,
} from "#templates/admin/site-pages.tsx";
import {
  isSitePageItemType,
  type SitePage,
  type SitePageItemType,
} from "#types";
import { seoContentInput } from "./content-form-fields.ts";
import {
  contentImageHandlers,
  contentPagePaths,
  contentRecordRoutes,
  saveContent,
} from "./content-save.ts";
import { buildListModel, offerableListing } from "./site-pages-data.ts";
import { sitePageEditForm, sitePageForm } from "./site-pages-form.ts";
import { sitePageEntityPage } from "./site-pages-page.ts";

// ─── Field validation ───────────────────────────────────────────

/** The encrypted content columns shared by create and update, plus the
 * Hidden box. The form sends "1" when the box is ticked and nothing when it
 * is not. */
const contentFields = (
  values: Parameters<typeof seoContentInput>[0] & { hidden: string },
  slug: string,
): SitePageWriteInput => ({
  ...seoContentInput(values),
  hidden: values.hidden === "1",
  slug,
});

// ─── Page CRUD ──────────────────────────────────────────────────

const LIST_PATH = adminPattern("sitePages");

const pageSlugInput = (
  values: Parameters<typeof contentFields>[0] & { slug: string },
): SitePageWriteInput => contentFields(values, normalizeSlug(values.slug));

const pages = recordPages(sitePageRecord, {
  ...contentPagePaths(sitePageRecord),
  editForm: sitePageEditForm,
  form: sitePageForm,
  renderDelete: adminSitePageDeletePage,
  renderEditError: sitePageEntityPage.renderEditError,
  renderList: async (navRows, session, successMessage) =>
    adminSitePagesListPage(
      await buildListModel(navRows),
      session,
      successMessage,
    ),
  renderNew: adminSitePageNewPage,
  toEditInput: pageSlugInput,
  toInput: pageSlugInput,
});

const images = contentImageHandlers({
  itemType: "page",
  load: records.site_pages.find,
  nameOf: (page) => page.name,
  record: sitePageRecord,
});

/** The Items and Images tabs live under the entity page. Their POST
 * sub-actions bounce back to the relevant tab, not the Edit form. */
const itemsPath = (id: number): string => `${LIST_PATH}/${id}/items`;

/** The flash, log line, and redirect target after one page item write. */
const itemSaved = (page: SitePage, flashKey: string, logMessage: string) => ({
  flashMessage: t(flashKey),
  logMessage,
  path: itemsPath(page.id),
});

const pageFormHandler = createIdEntityHandler<SitePage>(
  records.site_pages.find,
)(formGuard(SITE_FORM));

// ─── Root reorder ───────────────────────────────────────────────

const rootPageOrder = orderedListRoutes(ORDERED_LISTS.sitePage, {
  order: sitePageOrder,
  rows: () => idRows(loadPageForest().then(({ forest }) => forest.rootIds)),
});

// ─── Item manager ───────────────────────────────────────────────

/** Does `(type, id)` name a target this page can contain? Existence for a
 * leaf. Full tree-eligibility (unparented, no cycle) for a page.
 * Duplicate-edge and single-parent/cycle races are settled authoritatively by
 * `addPageItem`, which reports a conflict rather than throwing. */
const isEligibleTarget = async (
  pageId: number,
  type: SitePageItemType,
  itemId: number,
): Promise<boolean> => {
  if (type === "listing") {
    // Mirror the picker: only an offerable listing can be added. Single-row
    // reads — a POST validation never decrypts or scans the whole catalog.
    const [flags, childIds] = await Promise.all([
      getListingOfferFlags(itemId),
      getNonStandaloneChildIds([itemId]),
    ]);
    return flags !== undefined && offerableListing(itemId, flags, childIds);
  }
  if (type === "group") {
    // Single-row check: no name decryption, never the whole table.
    return readExists(records.groups.byId(itemId));
  }
  return eligibleChildPages((await loadPageForest()).forest, pageId).some(
    (p) => p.id === itemId,
  );
};

const handleAddItem = pageFormHandler(async (page, _session, form) => {
  const type = form.getString("itemType");
  const itemId = form.getOptionalInt("itemId");
  if (!isSitePageItemType(type) || itemId === null) {
    return errorRedirect(
      itemsPath(page.id),
      t("site.pages.error.invalid_item"),
    );
  }
  // Never trust the submitted select: re-check eligibility server-side, then
  // let addPageItem settle any concurrent-add conflict atomically. Either
  // failure answers with the same ineligible-error redirect, and addPageItem
  // does not run when the target is already ineligible.
  const eligible = await isEligibleTarget(page.id, type, itemId);
  if (!eligible) {
    return errorRedirect(itemsPath(page.id), t("site.pages.error.ineligible"));
  }
  return saveContent(
    async (transaction) =>
      (await addPageItem(page.id, type, itemId, transaction))
        ? page
        : errorRedirect(itemsPath(page.id), t("site.pages.error.ineligible")),
    () =>
      itemSaved(
        page,
        "site.pages.item_added",
        `Item added to page '${page.name}'`,
      ),
  );
});

type ItemRouteParams = { id: number; itemId: number; itemType: string };
type PageItem = { page: SitePage; ref: SitePageItemTarget };
const loadPageItem = ({ id, itemId, itemType }: ItemRouteParams) =>
  throughParent(records.site_pages.find(id), (page) =>
    isSitePageItemType(itemType)
      ? { page, ref: { id: itemId, kind: itemType } }
      : null,
  );
const pageItemHandler = createEntityHandler<ItemRouteParams, PageItem>(
  loadPageItem,
)(formGuard(SITE_FORM));

const handleRemoveItem = pageItemHandler(async ({ page, ref }) =>
  saveContent(
    async (transaction) => {
      await removePageItem(page.id, ref.kind, ref.id, transaction);
      return page;
    },
    () =>
      itemSaved(
        page,
        "site.pages.item_removed",
        `Item removed from page '${page.name}'`,
      ),
  ),
);

const pageItemOrder = orderedListRoutes(ORDERED_LISTS.sitePageItem, {
  arrange: (items, pageId) =>
    sitePageItemOrder.arrange({
      keys: items.map((item) => [item.type, item.id] as const),
      scope: pageId,
    }),
  rows: async (pageId) =>
    (await getItemsForPage(pageId)).map((item) => ({
      id: item.itemId,
      type: item.itemType,
    })),
});

// ─── Routes ─────────────────────────────────────────────────────

export const adminHandlers = defineAdminRoutes({
  ...contentRecordRoutes("sitePages", pages, images, sitePageEntityPage),
  ...imageOrderRoutes("page"),
  "POST /admin/site/pages/:id/items": handleAddItem,
  ...pageItemOrder,
  "POST /admin/site/pages/:id/items/:itemType/:itemId/remove": handleRemoveItem,
  ...rootPageOrder,
});
