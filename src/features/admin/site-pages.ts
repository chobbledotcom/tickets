import { handlersFor } from "#routes/admin/handlers.ts";
/**
 * Admin CRUD for user-created content Pages, under Site → Pages. Owner + editor
 * (SITE_FORM / requireSiteOr), hand-wired because create must assign a root
 * sort_order, root reordering is bounded to roots, and the edit page carries an
 * item manager the CRUD factory doesn't model. All the tree logic (forest,
 * eligibility, reorder neighbour) flows through the pure `site-pages/core`; the
 * read models live in `site-pages-data.ts`, and the edit page itself is the
 * shared tabbed entity page (Edit / Items / Images / Actions) in
 * `site-pages-page.ts`. This file owns the POST sub-actions and route wiring.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  type ConfirmedHandlers,
  createConfirmedHandlers,
} from "#routes/admin/confirmation.ts";
import {
  formGuard,
  SITE_FORM,
  SITE_MULTIPART,
  sitePage,
} from "#routes/auth.ts";
import {
  createEntityHandler,
  createIdEntityHandler,
  type IdParam,
} from "#routes/entity.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import {
  authedFormConfig,
  createAuthedFormRoute,
  createAuthedHandler,
} from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { groupExists } from "#shared/db/groups.ts";
import { getNonStandaloneChildIds } from "#shared/db/listing-parents.ts";
import { getListingOfferFlags } from "#shared/db/listings/catalog.ts";
import {
  addPageItem,
  getItemsForPage,
  type ItemRef,
  removePageItem,
  swapPageItemOrder,
} from "#shared/db/site-page-items.ts";
import {
  createSitePage,
  getSitePageById,
  type SitePageWriteInput,
  swapSitePageOrder,
  updateSitePage,
} from "#shared/db/site-pages.ts";
import { planReorder } from "#shared/reorder.ts";
import {
  eligibleChildPages,
  isReservedSlug,
  parseTargetKey,
  targetKey,
} from "#shared/site-pages/core.ts";
import { loadPageForest } from "#shared/site-pages/load.ts";
import { normalizeSlug } from "#shared/slug.ts";
import {
  type AdminSession,
  isSitePageItemType,
  type SitePage,
  type SitePageItemType,
} from "#shared/types.ts";
/* jscpd:ignore-end */
import {
  adminSitePageDeletePage,
  adminSitePageNewPage,
  adminSitePagesListPage,
} from "#templates/admin/site-pages.tsx";
import { seoContentInput } from "./content-form-fields.ts";
import { createItemImageHandlers } from "./item-images.ts";
import {
  contentWriteOrError,
  saveContent,
  siteConfirmAuth,
  siteContentPaths,
  siteListPage,
} from "./site-content.ts";
import { buildListModel, offerableListing } from "./site-pages-data.ts";
import { sitePageEditForm, sitePageForm } from "./site-pages-form.ts";
import { sitePageEntityPage } from "./site-pages-page.ts";

const paths = siteContentPaths("/admin/site/pages");
const LIST_PATH = paths.list;
const editPath = paths.edit;
/** The Items and Images tabs live under the entity page; their POST
 * sub-actions bounce back to the relevant tab, not the Edit form. */
const itemsPath = (id: number): string => `${LIST_PATH}/${id}/items`;
const imagesPath = (id: number): string => `${LIST_PATH}/${id}/images`;

// ─── Field validation ───────────────────────────────────────────

/** The encrypted content columns shared by create and update. */
const contentFields = (
  values: Parameters<typeof seoContentInput>[0],
  slug: string,
): SitePageWriteInput => ({
  ...seoContentInput(values),
  slug,
});

/** Normalize a validated slug and reject reserved public paths. The write itself
 * checks ownership atomically across listings, groups, and pages. */
const availableSlugOrError = (
  value: string,
  errorPath: string,
): string | Response => {
  // The slug field's own validator already ran `validateSlug(normalizeSlug())`
  // (so the format is known-good here); re-normalise for the reserved check and
  // storage.
  const slug = normalizeSlug(value);
  if (isReservedSlug(slug)) {
    return errorRedirect(errorPath, t("site.pages.error.reserved"));
  }
  return slug;
};

const withPageSlug = (
  value: string,
  errorPath: string,
  save: (slug: string) => Promise<Response>,
): Promise<Response> => {
  const slug = availableSlugOrError(value, errorPath);
  return slug instanceof Response ? Promise.resolve(slug) : save(slug);
};

// ─── Page CRUD ──────────────────────────────────────────────────

const renderList = siteListPage(buildListModel, adminSitePagesListPage);

const renderNew = sitePage((session, _request, flash) =>
  adminSitePageNewPage(session, flash.error),
);

const loadPage = ({ id }: { id: number }): Promise<SitePage | null> =>
  getSitePageById(id);
const pageEditPath = (page: SitePage): string => editPath(page.id);
const pageFormHandler = createIdEntityHandler<SitePage>(getSitePageById)(
  formGuard(SITE_FORM),
);
const createPageForm = authedFormConfig(
  SITE_FORM,
  sitePageForm,
  () => paths.newPage,
);
const editPageForm = authedFormConfig(
  SITE_FORM,
  sitePageEditForm,
  pageEditPath,
  loadPage,
);
const handleCreate = createAuthedFormRoute({
  ...createPageForm,
  onValid: ({ values }) =>
    withPageSlug(values.slug, paths.newPage, (slug) =>
      saveContent(
        async (transaction) => {
          const result = await createSitePage(
            contentFields(values, slug),
            transaction,
          );
          return contentWriteOrError(
            result,
            paths.newPage,
            t("site.pages.error.slug_taken"),
          );
        },
        (page) => ({
          flashMessage: t("site.pages.created"),
          logMessage: `Page '${values.name}' created`,
          path: editPath(page.id),
        }),
      ),
    ),
});
const handleUpdate = createAuthedFormRoute({
  ...editPageForm,
  onValid: async ({ context: page, values }) => {
    const path = editPath(page.id);
    return withPageSlug(values.slug, path, (slug) =>
      saveContent(
        async (transaction) =>
          contentWriteOrError(
            await updateSitePage(
              page.id,
              contentFields(values, slug),
              transaction,
            ),
            path,
            t("site.pages.error.slug_taken"),
          ),
        () => ({
          flashMessage: t("site.pages.updated"),
          logMessage: `Page '${values.name}' updated`,
          path,
        }),
      ),
    );
  },
});

const pageDelete: ConfirmedHandlers = createConfirmedHandlers<
  SitePage,
  AdminSession
>({
  auth: siteConfirmAuth,
  identifier: (p) => p.name,
  identifierLabel: t("site.pages.name_label"),
  load: (id) => getSitePageById(id),
  onConfirm: async (page) => {
    const { deleteSitePageWithEdges } = await import(
      "#shared/db/site-page-items.ts"
    );
    await deleteSitePageWithEdges(page.id);
    await logActivity(`Page '${page.name}' deleted`);
  },
  path: `${LIST_PATH}/:id/delete`,
  render: (page, session, error) =>
    adminSitePageDeletePage(page, session, error),
  successMessage: t("site.pages.deleted"),
  successRedirect: LIST_PATH,
});

// ─── Root reorder ───────────────────────────────────────────────

/** Move a root page one step in `dir` by swapping sort_order with its neighbour
 * among the *root* pages (nested pages are ordered by their edge, not here). */
const moveRoot = (dir: "up" | "down") =>
  createAuthedHandler<IdParam>({
    auth: SITE_FORM,
    handle: async ({ params: { id } }) => {
      const keys = (await loadPageForest()).forest.rootIds.map((rid) =>
        targetKey("page", rid),
      );
      const swap = planReorder(keys, targetKey("page", id), dir);
      if (swap) {
        await swapSitePageOrder(
          parseTargetKey(swap[0]).id,
          parseTargetKey(swap[1]).id,
        );
      }
      return redirect(LIST_PATH, t("site.pages.moved"), true);
    },
  });

// ─── Item manager ───────────────────────────────────────────────

/** Does `(type, id)` name a target this page may contain? Existence for a leaf;
 * full tree-eligibility (unparented, no cycle) for a page. Duplicate-edge and
 * single-parent/cycle races are settled authoritatively by `addPageItem`, which
 * reports a conflict rather than throwing. */
const isEligibleTarget = async (
  pageId: number,
  type: SitePageItemType,
  itemId: number,
): Promise<boolean> => {
  if (type === "listing") {
    // Mirror the picker: only an offerable listing may be added. Single-row
    // reads — a POST validation never decrypts or scans the whole catalog.
    const [flags, childIds] = await Promise.all([
      getListingOfferFlags(itemId),
      getNonStandaloneChildIds([itemId]),
    ]);
    return flags !== undefined && offerableListing(itemId, flags, childIds);
  }
  if (type === "group") return groupExists(itemId);
  return eligibleChildPages((await loadPageForest()).forest, pageId).some(
    (p) => p.id === itemId,
  );
};

const handleAddItem = pageFormHandler(async (page, _session, form) => {
  const type = form.getString("item_type");
  const itemId = form.getOptionalInt("item_id");
  if (!isSitePageItemType(type) || itemId === null) {
    return errorRedirect(
      itemsPath(page.id),
      t("site.pages.error.invalid_item"),
    );
  }
  // Never trust the submitted select: re-check eligibility server-side, then let
  // addPageItem settle any concurrent-add conflict atomically. Either failing is
  // the same friendly "can't be added" (addPageItem isn't called when the target
  // is already ineligible).
  const eligible = await isEligibleTarget(page.id, type, itemId);
  if (!eligible) {
    return errorRedirect(itemsPath(page.id), t("site.pages.error.ineligible"));
  }
  return saveContent(
    async (transaction) =>
      (await addPageItem(page.id, type, itemId, transaction))
        ? page
        : errorRedirect(itemsPath(page.id), t("site.pages.error.ineligible")),
    () => ({
      flashMessage: t("site.pages.item_added"),
      logMessage: `Item added to page '${page.name}'`,
      path: itemsPath(page.id),
    }),
  );
});

type ItemRouteParams = { id: number; itemId: number; itemType: string };
type PageItem = { page: SitePage; ref: ItemRef };
const pageItemHandler = createEntityHandler<ItemRouteParams, PageItem>(
  async ({ id, itemId, itemType }) => {
    if (!isSitePageItemType(itemType)) return null;
    const page = await getSitePageById(id);
    return page ? { page, ref: { id: itemId, type: itemType } } : null;
  },
)(formGuard(SITE_FORM));

const handleRemoveItem = pageItemHandler(async ({ page, ref }) =>
  saveContent(
    async (transaction) => {
      await removePageItem(page.id, ref.type, ref.id, transaction);
      return page;
    },
    () => ({
      flashMessage: t("site.pages.item_removed"),
      logMessage: `Item removed from page '${page.name}'`,
      path: itemsPath(page.id),
    }),
  ),
);

const moveItem = (dir: "up" | "down") =>
  createAuthedHandler<ItemRouteParams>({
    auth: SITE_FORM,
    handle: async ({ params: { id, itemId, itemType } }) => {
      if (!isSitePageItemType(itemType)) return notFoundResponse();
      const ref: ItemRef = { id: itemId, type: itemType };
      const items = await getItemsForPage(id);
      const keys = items.map((i) => targetKey(i.item_type, i.item_id));
      const swap = planReorder(keys, targetKey(ref.type, ref.id), dir);
      if (swap) {
        await swapPageItemOrder(
          id,
          parseTargetKey(swap[0]),
          parseTargetKey(swap[1]),
        );
      }
      return redirect(itemsPath(id), t("site.pages.moved"), true);
    },
  });

// ─── Images ─────────────────────────────────────────────────────

/** The shared per-entity image handlers, gated at the Site level (owner +
 * editor) to match the pages themselves. A successful save stays on the Images
 * tab, but a storage-disabled bounce redirects to the Edit tab: the Images tab
 * is hidden when storage is off, so a redirect there would 404 and swallow the
 * "storage not configured" message. */
const pageImageHandlers = createItemImageHandlers({
  auth: { form: SITE_FORM, multipart: SITE_MULTIPART },
  disabledPath: editPath,
  itemType: "page",
  load: getSitePageById,
  nameOf: (page) => page.name,
  path: imagesPath,
});

// ─── Routes ─────────────────────────────────────────────────────

export const adminHandlers = handlersFor("sitePages")({
  getSitePages: renderList,
  getSitePagesById: (request, { id }) =>
    sitePageEntityPage.renderTab(request, id, ""),
  getSitePagesByIdByTab: (request, { id, tab }) =>
    sitePageEntityPage.renderTab(request, id, tab),
  getSitePagesByIdDelete: (request, { id }) => pageDelete.get(request, id),
  getSitePagesNew: renderNew,
  postSitePages: handleCreate,
  postSitePagesByIdDelete: (request, { id }) => pageDelete.post(request, id),
  postSitePagesByIdEdit: handleUpdate,
  postSitePagesByIdImages: pageImageHandlers.set,
  postSitePagesByIdImagesUpload: pageImageHandlers.upload,
  postSitePagesByIdItems: handleAddItem,
  postSitePagesByIdItemsByItemTypeByItemIdMoveDown: moveItem("down"),
  postSitePagesByIdItemsByItemTypeByItemIdMoveUp: moveItem("up"),
  postSitePagesByIdItemsByItemTypeByItemIdRemove: handleRemoveItem,
  postSitePagesByIdMoveDown: moveRoot("down"),
  postSitePagesByIdMoveUp: moveRoot("up"),
});
