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
import { SITE_FORM, SITE_MULTIPART, withAuth } from "#routes/auth.ts";
import type { IdParam } from "#routes/entity.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
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
  isSitePageSlugTaken,
  swapSitePageOrder,
  updateSitePage,
} from "#shared/db/site-pages.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  eligibleChildPages,
  isReservedSlug,
  parseTargetKey,
  planReorder,
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
  savedContentResponse,
  siteConfirmAuth,
  siteContentGet,
  siteContentPaths,
  siteEntityPost,
  validateContentFormOr,
} from "./site-content.ts";
import { siteCreatePost } from "./site-content-create.ts";
import { buildListModel, offerableListing } from "./site-pages-data.ts";
import { sitePageForm } from "./site-pages-form.ts";
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
const contentFields = (form: FormParams, name: string, slug: string) => ({
  ...seoContentInput(form, name),
  slug,
});

/** Validate name + slug (format, reserved words, cross-table uniqueness).
 * On failure returns the error redirect to bounce back to `errorPath`. */
const validateFields = async (
  form: FormParams,
  errorPath: string,
  excludeId?: number,
): Promise<
  { ok: true; name: string; slug: string } | { ok: false; response: Response }
> => {
  const result = validateContentFormOr(sitePageForm.validate(form), errorPath);
  if (!result.ok) return result;
  // The slug field's own validator already ran `validateSlug(normalizeSlug())`
  // (so the format is known-good here); re-normalise for the reserved/uniqueness
  // checks and storage.
  const slug = normalizeSlug(result.values.slug);
  if (isReservedSlug(slug)) {
    const msg = t("site.pages.error.reserved");
    return { ok: false, response: errorRedirect(errorPath, msg) };
  }
  if (await isSitePageSlugTaken(slug, excludeId)) {
    const msg = t("site.pages.error.slug_taken");
    return { ok: false, response: errorRedirect(errorPath, msg) };
  }
  return { name: result.values.name, ok: true, slug };
};

// ─── Handler wrappers ───────────────────────────────────────────

/** Load the target page or answer 404, then hand it to `hit`. */
const loadPageOr404 = async (
  id: number,
  hit: (page: SitePage) => Promise<Response>,
): Promise<Response> => {
  const page = await getSitePageById(id);
  return page ? hit(page) : notFoundResponse();
};

/** Curry a `:id` route: unpack the id param and pass it to `run`. */
const idHandler =
  (run: (request: Request, id: number) => Promise<Response>) =>
  (request: Request, params: IdParam): Promise<Response> =>
    run(request, params.id);

/** SITE_FORM POST handler keyed on `:id`. */
const idPost = (
  handler: (id: number, form: FormParams) => Promise<Response>,
): ReturnType<typeof idHandler> =>
  idHandler((request, id) =>
    withAuth(request, SITE_FORM, (_session, form) => handler(id, form)),
  );

/** SITE_FORM POST handler keyed on `(:id, :itemType, :itemId)`. The router's
 * numeric-param rule has already turned `:id`/`:itemId` into numbers; only the
 * `:itemType` segment needs validating here. */
const itemPost =
  (
    handler: (ref: ItemRef, id: number, form: FormParams) => Promise<Response>,
  ) =>
  (
    request: Request,
    { id, itemType, itemId }: { id: number; itemType: string; itemId: number },
  ): Promise<Response> =>
    withAuth(request, SITE_FORM, (_session, form) =>
      isSitePageItemType(itemType)
        ? handler({ id: itemId, type: itemType }, id, form)
        : notFoundResponse(),
    );

// ─── Page CRUD ──────────────────────────────────────────────────

const renderList = siteContentGet(async (session) =>
  adminSitePagesListPage(await buildListModel(), session),
);

const renderNew = siteContentGet((session) => adminSitePageNewPage(session));

const handleCreate = siteCreatePost(
  paths.newPage,
  validateFields,
  async (fields, form) => {
    const page = await createSitePage(
      contentFields(form, fields.name, fields.slug),
    );
    return {
      flashMessage: t("site.pages.created"),
      logMessage: `Page '${fields.name}' created`,
      path: editPath(page.id),
    };
  },
);

const handleUpdate = siteEntityPost(getSitePageById)(async (page, form) => {
  const fields = await validateFields(form, editPath(page.id), page.id);
  if (!fields.ok) return fields.response;
  await updateSitePage(page.id, contentFields(form, fields.name, fields.slug));
  return savedContentResponse(
    editPath(page.id),
    `Page '${fields.name}' updated`,
    t("site.pages.updated"),
  );
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
  idPost(async (id) => {
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

const handleAddItem = siteEntityPost(getSitePageById)(async (page, form) => {
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
  const added = eligible && (await addPageItem(page.id, type, itemId));
  if (!added) {
    return errorRedirect(itemsPath(page.id), t("site.pages.error.ineligible"));
  }
  return savedContentResponse(
    itemsPath(page.id),
    `Item added to page '${page.name}'`,
    t("site.pages.item_added"),
  );
});

const handleRemoveItem = itemPost((ref, id) =>
  loadPageOr404(id, async (page) => {
    await removePageItem(id, ref.type, ref.id);
    return savedContentResponse(
      itemsPath(id),
      `Item removed from page '${page.name}'`,
      t("site.pages.item_removed"),
    );
  }),
);

const moveItem = (dir: "up" | "down") =>
  itemPost(async (ref, id) => {
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
