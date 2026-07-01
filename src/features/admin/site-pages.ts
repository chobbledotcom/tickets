/**
 * Admin CRUD for user-created content Pages, under Site → Pages. Owner + editor
 * (SITE_FORM / requireSiteOr), hand-wired because create must assign a root
 * sort_order, root reordering is bounded to roots, and the edit page carries an
 * item manager the CRUD factory doesn't model. All the tree logic (forest,
 * eligibility, reorder neighbour) flows through the pure `site-pages/core`.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  type ConfirmedHandlers,
  createConfirmedHandlers,
} from "#routes/admin/confirmation.ts";
import { requireSiteOr, SITE_FORM, withAuth } from "#routes/auth.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllGroupNames } from "#shared/db/groups.ts";
import { getAllListingNames } from "#shared/db/listings.ts";
import {
  addPageItem,
  getAllPageItems,
  getItemsForPage,
  type ItemRef,
  removePageItem,
  swapPageItemOrder,
} from "#shared/db/site-page-items.ts";
import {
  computeSitePageSlugIndex,
  createSitePage,
  getSitePageById,
  getSitePageNavRows,
  isSitePageSlugTaken,
  swapSitePageOrder,
  updateSitePage,
} from "#shared/db/site-pages.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  buildForest,
  eligibleChildPages,
  isReservedSlug,
  parseTargetKey,
  planReorder,
  targetKey,
} from "#shared/site-pages/core.ts";
import type { Forest } from "#shared/site-pages/types.ts";
import { normalizeSlug } from "#shared/slug.ts";
import type {
  AdminSession,
  SitePage,
  SitePageItemType,
  SitePageNavRow,
} from "#shared/types.ts";
/* jscpd:ignore-end */
import {
  adminSitePageDeletePage,
  adminSitePageEditPage,
  adminSitePageNewPage,
  adminSitePagesListPage,
  type EditModel,
  type ListModel,
  type PickerOption,
  type ResolvedItem,
} from "#templates/admin/site-pages.tsx";
import { sitePageForm } from "./site-pages-form.ts";

const LIST_PATH = "/admin/site/pages";
const newPath = `${LIST_PATH}/new`;
const editPath = (id: number): string => `${LIST_PATH}/${id}/edit`;

const ITEM_TYPES: readonly SitePageItemType[] = ["listing", "group", "page"];
const isItemType = (v: string): v is SitePageItemType =>
  (ITEM_TYPES as readonly string[]).includes(v);

// ─── Loaders ────────────────────────────────────────────────────

/** Load the nav rows + item edges once and fold them into the page forest. */
const loadForest = async (): Promise<{
  forest: Forest;
  navRows: SitePageNavRow[];
}> => {
  const [navRows, items] = await Promise.all([
    getSitePageNavRows(),
    getAllPageItems(),
  ]);
  return { forest: buildForest(navRows, items), navRows };
};

// ─── Read models ────────────────────────────────────────────────

/** Build the list-page model: root pages (reorderable) and nested pages (shown
 * with their parent, edited through the item manager). */
const buildListModel = async (): Promise<ListModel> => {
  const { forest, navRows } = await loadForest();
  const roots = forest.rootIds.map((id) => forest.byId.get(id)!);
  const nested = navRows
    .filter((p) => forest.parentByChild.has(p.id))
    .map((p) => ({
      page: p,
      // parentByChild only maps children whose parent is a real page in byId.
      parentName: forest.byId.get(forest.parentByChild.get(p.id)!)!.name,
    }));
  return { nested, roots };
};

/** Resolve a page's items to display rows + the add-item picker options. */
const buildEditModel = async (page: SitePage): Promise<EditModel> => {
  // Pickers/labels need only id + name, so use the narrow name projections
  // rather than the full listings/groups caches (no decrypting every column).
  const [navRows, allItems, listingNames, groupNames, pageItems] =
    await Promise.all([
      getSitePageNavRows(),
      getAllPageItems(),
      getAllListingNames(),
      getAllGroupNames(),
      getItemsForPage(page.id),
    ]);
  const forest = buildForest(navRows, allItems);
  const pageById = new Map(navRows.map((r) => [r.id, r.name]));
  const label = (type: SitePageItemType, id: number): string => {
    const lookup: Record<SitePageItemType, string | undefined> = {
      group: groupNames.get(id),
      listing: listingNames.get(id),
      page: pageById.get(id),
    };
    return lookup[type] ?? t("site.pages.item_missing");
  };
  const items: ResolvedItem[] = pageItems.map((i) => ({
    id: i.item_id,
    label: label(i.item_type, i.item_id),
    type: i.item_type,
  }));
  const opt = (id: number, name: string): PickerOption => ({
    label: name,
    value: String(id),
  });
  // A leaf may sit on a page only once (unique (page_id, item_type, item_id)),
  // so drop targets already present from the pickers.
  const present = new Set(
    pageItems.map((i) => targetKey(i.item_type, i.item_id)),
  );
  const options = (
    names: Map<number, string>,
    type: SitePageItemType,
  ): PickerOption[] =>
    [...names]
      .filter(([id]) => !present.has(targetKey(type, id)))
      .map(([id, name]) => opt(id, name));
  return {
    groupOptions: options(groupNames, "group"),
    items,
    listingOptions: options(listingNames, "listing"),
    page,
    pageOptions: eligibleChildPages(forest, page.id).map((p) =>
      opt(p.id, p.name),
    ),
  };
};

// ─── Field validation ───────────────────────────────────────────

/** The encrypted content columns shared by create and update. */
const contentFields = (form: FormParams, name: string, slug: string) => ({
  content: form.getString("content"),
  metaDescription: form.getString("meta_description"),
  metaTitle: form.getString("meta_title"),
  name,
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
  const result = sitePageForm.validate(form);
  if (!result.valid) {
    return { ok: false, response: errorRedirect(errorPath, result.error) };
  }
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
  (request: Request, params: { id: number }): Promise<Response> =>
    run(request, params.id);

/** SITE_FORM POST handler keyed on `:id`. */
const idPost = (
  handler: (id: number, form: FormParams) => Promise<Response>,
): ReturnType<typeof idHandler> =>
  idHandler((request, id) =>
    withAuth(request, SITE_FORM, (_session, form) => handler(id, form)),
  );

/** POST handler that loads the `:id` page (or 404s) before mutating. */
const pagePost = (
  handler: (page: SitePage, form: FormParams) => Promise<Response>,
) => idPost((id, form) => loadPageOr404(id, (page) => handler(page, form)));

/** GET handler that loads the `:id` page (or 404s) before rendering. */
const pageGet = (
  render: (page: SitePage, session: AdminSession) => Promise<string> | string,
): ReturnType<typeof idHandler> =>
  idHandler((request, id) =>
    requireSiteOr(request, (session) =>
      loadPageOr404(id, async (page) =>
        htmlResponse(await render(page, session)),
      ),
    ),
  );

/** SITE_FORM POST handler keyed on `(:id, :itemType, :itemId)`. */
const itemPost =
  (
    handler: (ref: ItemRef, id: number, form: FormParams) => Promise<Response>,
  ) =>
  (
    request: Request,
    { id, itemType, itemId }: { id: number; itemType: string; itemId: number },
  ): Promise<Response> =>
    withAuth(request, SITE_FORM, (_session, form) => {
      const ref = parseItemRef(itemType, itemId);
      return ref ? handler(ref, id, form) : notFoundResponse();
    });

// ─── Page CRUD ──────────────────────────────────────────────────

const renderList = (request: Request): Promise<Response> =>
  requireSiteOr(request, async (session) =>
    htmlResponse(adminSitePagesListPage(await buildListModel(), session)),
  );

const renderNew = (request: Request): Promise<Response> =>
  requireSiteOr(request, (session) =>
    htmlResponse(adminSitePageNewPage(session)),
  );

const renderEdit = pageGet(async (page, session) =>
  adminSitePageEditPage(await buildEditModel(page), session),
);

const handleCreate = (request: Request): Promise<Response> =>
  withAuth(request, SITE_FORM, async (_session, form) => {
    const fields = await validateFields(form, newPath);
    if (!fields.ok) return fields.response;
    const page = await createSitePage({
      ...contentFields(form, fields.name, fields.slug),
      slugIndex: await computeSitePageSlugIndex(fields.slug),
    });
    await logActivity(`Page '${fields.name}' created`);
    return redirect(editPath(page.id), t("site.pages.created"), true);
  });

const handleUpdate = pagePost(async (page, form) => {
  const fields = await validateFields(form, editPath(page.id), page.id);
  if (!fields.ok) return fields.response;
  await updateSitePage(page.id, {
    ...contentFields(form, fields.name, fields.slug),
    // Recompute the blind index so a renamed slug stays findable/reservable.
    slugIndex: await computeSitePageSlugIndex(fields.slug),
  });
  await logActivity(`Page '${fields.name}' updated`);
  return redirect(editPath(page.id), t("site.pages.updated"), true);
});

const pageDelete: ConfirmedHandlers = createConfirmedHandlers<
  SitePage,
  AdminSession
>({
  auth: {
    requireSession: requireSiteOr,
    withForm: (r, h) => withAuth(r, SITE_FORM, h),
  },
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
    const keys = (await loadForest()).forest.rootIds.map((rid) =>
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
  if (type === "listing") return (await getAllListingNames()).has(itemId);
  if (type === "group") return (await getAllGroupNames()).has(itemId);
  return eligibleChildPages((await loadForest()).forest, pageId).some(
    (p) => p.id === itemId,
  );
};

const handleAddItem = pagePost(async (page, form) => {
  const type = form.getString("item_type");
  const itemId = form.getOptionalInt("item_id");
  if (!isItemType(type) || itemId === null) {
    return errorRedirect(editPath(page.id), t("site.pages.error.invalid_item"));
  }
  // Never trust the submitted select: re-check eligibility server-side, then let
  // addPageItem settle any concurrent-add conflict atomically. Either failing is
  // the same friendly "can't be added" (addPageItem isn't called when the target
  // is already ineligible).
  const eligible = await isEligibleTarget(page.id, type, itemId);
  const added = eligible && (await addPageItem(page.id, type, itemId));
  if (!added) {
    return errorRedirect(editPath(page.id), t("site.pages.error.ineligible"));
  }
  await logActivity(`Item added to page '${page.name}'`);
  return redirect(editPath(page.id), t("site.pages.item_added"), true);
});

/** Parse the `(itemType, itemId)` route params into a validated {@link ItemRef}. */
const parseItemRef = (itemType: unknown, itemId: unknown): ItemRef | null => {
  const type = String(itemType);
  const id = Number(itemId);
  return isItemType(type) && Number.isInteger(id) ? { id, type } : null;
};

const handleRemoveItem = itemPost((ref, id) =>
  loadPageOr404(id, async (page) => {
    await removePageItem(id, ref.type, ref.id);
    await logActivity(`Item removed from page '${page.name}'`);
    return redirect(editPath(id), t("site.pages.item_removed"), true);
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
    return redirect(editPath(id), t("site.pages.moved"), true);
  });

// ─── Routes ─────────────────────────────────────────────────────

export const sitePagesRoutes = {
  ...pageDelete.routes,
  ...defineRoutes({
    "GET /admin/site/pages": renderList,
    "GET /admin/site/pages/:id/edit": renderEdit,
    "GET /admin/site/pages/new": renderNew,
    "POST /admin/site/pages": handleCreate,
    "POST /admin/site/pages/:id/edit": handleUpdate,
    "POST /admin/site/pages/:id/items": handleAddItem,
    "POST /admin/site/pages/:id/items/:itemType/:itemId/move-down":
      moveItem("down"),
    "POST /admin/site/pages/:id/items/:itemType/:itemId/move-up":
      moveItem("up"),
    "POST /admin/site/pages/:id/items/:itemType/:itemId/remove":
      handleRemoveItem,
    "POST /admin/site/pages/:id/move-down": moveRoot("down"),
    "POST /admin/site/pages/:id/move-up": moveRoot("up"),
  }),
};
