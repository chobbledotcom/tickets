import { defineRoutes } from "#routes/router.ts";

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

import { logActivity } from "#db/activity-log.ts";
import { groupExists } from "#db/groups.ts";
import { getNonStandaloneChildIds } from "#db/listing-parents.ts";
import { getListingOfferFlags } from "#db/listings/catalog.ts";
import {
  addPageItem,
  getItemsForPage,
  removePageItem,
  sitePageItemOrder,
} from "#db/site-page-items.ts";
import {
  createSitePage,
  getSitePageById,
  type SitePageWriteInput,
  sitePageOrder,
  updateSitePage,
} from "#db/site-pages.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import { formGuard, SITE_FORM } from "#routes/auth.ts";
import {
  createEntityHandler,
  createIdEntityHandler,
  type IdParam,
  throughParent,
} from "#routes/entity.ts";
import { errorRedirect } from "#routes/response.ts";
import { createOrderedCollectionHandlers } from "#shared/app-forms.ts";
import { eligibleChildPages, isReservedSlug } from "#shared/site-pages/core.ts";
import { loadPageForest } from "#shared/site-pages/load.ts";
import {
  type SitePageItemTarget,
  sitePageItemTargets,
  targetOfPageItem,
} from "#shared/site-pages/target.ts";
import { normalizeSlug } from "#shared/slug.ts";
/* jscpd:ignore-end */
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
  contentWriteOrError,
  defineSiteContent,
  saveContent,
} from "./site-content.ts";
import { buildListModel, offerableListing } from "./site-pages-data.ts";
import { sitePageEditForm, sitePageForm } from "./site-pages-form.ts";
import { sitePageEntityPage } from "./site-pages-page.ts";

// ─── Field validation ───────────────────────────────────────────

/** The encrypted content columns shared by create and update. */
const contentFields = (
  values: Parameters<typeof seoContentInput>[0],
  slug: string,
): SitePageWriteInput => ({
  ...seoContentInput(values),
  slug,
});

type SitePageContentValues = Parameters<typeof contentFields>[0] & {
  slug: string;
};

/** Normalize a validated slug and reject reserved public paths. The write itself
 * checks ownership atomically across listings, groups, and pages. */
const reservedSlugError = (
  value: string,
  errorPath: string,
): Response | undefined => {
  // The slug field's own validator already ran `validateSlug(normalizeSlug())`
  // (so the format is known-good here); re-normalise for the reserved check and
  // storage.
  const slug = normalizeSlug(value);
  if (isReservedSlug(slug)) {
    return errorRedirect(errorPath, t("site.pages.error.reserved"));
  }
  return;
};

// ─── Page CRUD ──────────────────────────────────────────────────

const content = defineSiteContent("/admin/site/pages", (paths) => ({
  create: {
    flashMessage: t("site.pages.created"),
    logMessage: (_page: SitePage, values: SitePageContentValues) =>
      `Page '${values.name}' created`,
    validate: (values: SitePageContentValues) =>
      reservedSlugError(values.slug, paths.newPage),
    write: async (values: SitePageContentValues, transaction) =>
      contentWriteOrError(
        await createSitePage(
          contentFields(values, normalizeSlug(values.slug)),
          transaction,
        ),
        paths.newPage,
        t("site.pages.error.slug_taken"),
      ),
  },
  createForm: sitePageForm,
  delete: {
    identifier: (page: SitePage) => page.name,
    identifierLabel: t("site.pages.name_label"),
    onConfirm: async (page: SitePage) => {
      const { deleteSitePageWithEdges } = await import(
        "#db/site-page-items.ts"
      );
      await deleteSitePageWithEdges(page.id);
      await logActivity(`Page '${page.name}' deleted`);
    },
    render: adminSitePageDeletePage,
    successMessage: t("site.pages.deleted"),
  },
  editForm: sitePageEditForm,
  entityPage: sitePageEntityPage,
  imageType: "page",
  load: getSitePageById,
  loadList: buildListModel,
  renderList: adminSitePagesListPage,
  renderNew: adminSitePageNewPage,
  update: {
    flashMessage: t("site.pages.updated"),
    logMessage: (_page: SitePage, values: SitePageContentValues) =>
      `Page '${values.name}' updated`,
    validate: (values: SitePageContentValues, page: SitePage) =>
      reservedSlugError(values.slug, paths.edit(page.id)),
    write: async (values: SitePageContentValues, transaction, page) =>
      contentWriteOrError(
        await updateSitePage(
          page.id,
          contentFields(values, normalizeSlug(values.slug)),
          transaction,
        ),
        paths.edit(page.id),
        t("site.pages.error.slug_taken"),
      ),
  },
}));

const { paths } = content;
const LIST_PATH = paths.list;
/** The Items and Images tabs live under the entity page; their POST
 * sub-actions bounce back to the relevant tab, not the Edit form. */
const itemsPath = (id: number): string => `${LIST_PATH}/${id}/items`;

const pageTarget = sitePageItemTargets.of("page");
const pageFormHandler = createIdEntityHandler<SitePage>(getSitePageById)(
  formGuard(SITE_FORM),
);

// ─── Root reorder ───────────────────────────────────────────────

const rootPageOrder = createOrderedCollectionHandlers({
  auth: SITE_FORM,
  keys: async () =>
    (await loadPageForest()).forest.rootIds.map((id) =>
      sitePageItemTargets.key(pageTarget(id)),
    ),
  movedMessage: t("site.pages.moved"),
  redirectPath: () => LIST_PATH,
  swap: (first, second) =>
    sitePageOrder.swap({
      first: sitePageItemTargets.fromKey(first).id,
      second: sitePageItemTargets.fromKey(second).id,
    }),
  target: ({ params }: { params: IdParam }) =>
    sitePageItemTargets.key(pageTarget(params.id)),
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
type PageItem = { page: SitePage; ref: SitePageItemTarget };
const loadPageItem = ({ id, itemId, itemType }: ItemRouteParams) =>
  throughParent(getSitePageById(id), (page) =>
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
    () => ({
      flashMessage: t("site.pages.item_removed"),
      logMessage: `Item removed from page '${page.name}'`,
      path: itemsPath(page.id),
    }),
  ),
);

const pageItemOrder = createOrderedCollectionHandlers({
  auth: SITE_FORM,
  keys: async ({ params }) =>
    (await getItemsForPage(params.id)).map((item) =>
      sitePageItemTargets.key(targetOfPageItem(item)),
    ),
  loadContext: async ({ itemId, itemType }: ItemRouteParams) =>
    isSitePageItemType(itemType) ? { id: itemId, kind: itemType } : null,
  movedMessage: t("site.pages.moved"),
  redirectPath: ({ params }) => itemsPath(params.id),
  swap: (first, second, { params }) => {
    const firstRef = sitePageItemTargets.fromKey(first);
    const secondRef = sitePageItemTargets.fromKey(second);
    return sitePageItemOrder.swap({
      first: [firstRef.kind, firstRef.id],
      scope: params.id,
      second: [secondRef.kind, secondRef.id],
    });
  },
  target: ({ context }) => sitePageItemTargets.key(context),
});

// ─── Routes ─────────────────────────────────────────────────────

export const adminHandlers = defineRoutes({
  "GET /admin/site/pages": content.list,
  "GET /admin/site/pages/:id": content.entity,
  "GET /admin/site/pages/:id/:tab": content.entityTab,
  "GET /admin/site/pages/:id/delete": content.deletePage,
  "GET /admin/site/pages/new": content.newPage,
  "POST /admin/site/pages": content.create,
  "POST /admin/site/pages/:id/delete": content.delete,
  "POST /admin/site/pages/:id/edit": content.update,
  "POST /admin/site/pages/:id/images": content.images.set,
  "POST /admin/site/pages/:id/images/upload": content.images.upload,
  "POST /admin/site/pages/:id/items": handleAddItem,
  "POST /admin/site/pages/:id/items/:itemType/:itemId/move-down":
    pageItemOrder.down,
  "POST /admin/site/pages/:id/items/:itemType/:itemId/move-up":
    pageItemOrder.up,
  "POST /admin/site/pages/:id/items/:itemType/:itemId/remove": handleRemoveItem,
  "POST /admin/site/pages/:id/move-down": rootPageOrder.down,
  "POST /admin/site/pages/:id/move-up": rootPageOrder.up,
});
