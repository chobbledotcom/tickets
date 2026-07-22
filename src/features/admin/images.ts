import { defineRoutes } from "#routes/router.ts";
/**
 * First-class image library admin routes.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import {
  CONTENT_FORM,
  CONTENT_MULTIPART,
  formGuard,
  requireContentOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { groups } from "#shared/db/groups.ts";
import {
  deleteImageRecord,
  getAllImages,
  getImageById,
  getImageUsesForImage,
  type ImageUseTarget,
  imagesTable,
  setItemsForImage,
} from "#shared/db/images.ts";
import { getAllListingOptions } from "#shared/db/listings/records.ts";
import { getNewsPostNames } from "#shared/db/news-posts.ts";
import { sitePages } from "#shared/db/site-pages.ts";
import type { FormParams } from "#shared/form-data.ts";
import { featureGate } from "#shared/response-steps.ts";
import {
  deleteImageStorageFilesStrict,
  isStorageEnabled,
} from "#shared/storage.ts";
import {
  type AdminLevel,
  type Image,
  type ImageUseItemType,
  isImageUseItemType,
  isSiteRole,
} from "#shared/types.ts";
import {
  adminImageDeletePage,
  adminImageEditPage,
  adminImageNewPage,
  adminImagesPage,
  type ImageItemOption,
} from "#templates/admin/images.tsx";
import { imageMetadataFromForm, withUploadedImage } from "./image-upload.ts";

// jscpd:ignore-end

const imagePath = (id: number): string => `/admin/images/${id}/edit`;
const withStorageEnabled = featureGate(isStorageEnabled, () =>
  redirect("/admin/images", t("images.storage_off"), false),
);
const imageHandler = createIdEntityHandler<Image>(getImageById);
type ImagePost = (
  image: Image,
  form: FormParams,
  adminLevel: AdminLevel,
) => Promise<Response>;
const imagePost = imageHandler(formGuard(CONTENT_FORM));
const imageHandlers = {
  get: imageHandler(requireContentOr),
  post: (action: ImagePost): IdRouteHandler =>
    imagePost((image, session, form) =>
      withStorageEnabled(() => action(image, form, session.adminLevel)),
    ),
};

const handleImagesListGet: TypedRouteHandler<"GET /admin/images"> = (request) =>
  requireContentOr(request, async (session) => {
    applyFlash(request);
    const images = isStorageEnabled() ? await getAllImages() : [];
    return htmlResponse(adminImagesPage(images, session));
  });

const handleImageNewGet: TypedRouteHandler<"GET /admin/images/new"> = (
  request,
) =>
  requireContentOr(request, (session) => {
    applyFlash(request);
    return withStorageEnabled(() => htmlResponse(adminImageNewPage(session)));
  });

const handleImageCreatePost: TypedRouteHandler<"POST /admin/images"> = (
  request,
) =>
  withAuth(request, CONTENT_MULTIPART, (_session, formData) =>
    withStorageEnabled(() =>
      withUploadedImage(formData, "/admin/images/new", async (image) => {
        await logActivity(`Image '${image.name}' uploaded`);
        return redirect(imagePath(image.id), t("images.created"), true);
      }),
    ),
  );

const listingImageItemOptions = async (): Promise<ImageItemOption[]> =>
  (await getAllListingOptions()).map((listing) => ({
    active: listing.active,
    id: listing.id,
    label: listing.name,
    type: "listing" as const,
  }));

/** Options of one always-active type from (id, label) pairs — groups and news
 * posts have no deactivated state. */
const activeOptionsOfType =
  (type: ImageUseItemType) =>
  (entries: Iterable<readonly [number, string]>): ImageItemOption[] =>
    [...entries].map(([id, label]) => ({ active: true, id, label, type }));

const groupImageItemOptions = async (): Promise<ImageItemOption[]> =>
  activeOptionsOfType("group")(
    (await groups.cache.getAll()).map(
      (group) => [group.id, group.name] as const,
    ),
  );

/** News + page options — the Site-gated content types, shown only to a Site
 * role. Both are read one narrow name projection at a time. */
const siteContentImageOptions = async (): Promise<ImageItemOption[]> => [
  ...activeOptionsOfType("news")(await getNewsPostNames()),
  ...activeOptionsOfType("page")(
    (await sitePages.getAll()).map((page) => [page.id, page.name] as const),
  ),
];

/** The link targets this session may manage. News posts and pages are
 * Site-gated (owner + editor): a manager never sees them here, matching the
 * Site content image routes that exclude managers. */
const imageItemOptions = async (
  adminLevel: AdminLevel,
): Promise<ImageItemOption[]> => [
  ...(await listingImageItemOptions()),
  ...(await groupImageItemOptions()),
  ...(isSiteRole(adminLevel) ? await siteContentImageOptions() : []),
];

const selectedUses = async (imageId: number): Promise<Set<string>> =>
  new Set(
    (await getImageUsesForImage(imageId)).map(
      (use) => `${use.item_type}:${use.item_id}`,
    ),
  );

const handleImageEditGet: TypedRouteHandler<"GET /admin/images/:id/edit"> =
  imageHandlers.get(async (image, session, request) => {
    applyFlash(request);
    return withStorageEnabled(async () => {
      const [options, selected] = await Promise.all([
        imageItemOptions(session.adminLevel),
        selectedUses(image.id),
      ]);
      return htmlResponse(
        adminImageEditPage({ image, options, selected, session }),
      );
    });
  });

const parseImageTargets = (form: FormParams): ImageUseTarget[] =>
  form
    .getAll("image_items")
    .map((raw) => {
      const [itemType = "", itemId = ""] = raw.split(":");
      const id = Number(itemId);
      return isImageUseItemType(itemType) && Number.isSafeInteger(id) && id > 0
        ? { itemId: id, itemType }
        : null;
    })
    .filter((target): target is ImageUseTarget => target !== null);

/** The image-use item types that are public Site content (owner + editor):
 * news posts and pages. An image on either surfaces publicly, so a manager may
 * not manage it. */
const isSiteContentImageType = (type: ImageUseItemType): boolean =>
  type === "news" || type === "page";

/** Does this image sit on any Site content (a news post or a page)? Its
 * metadata (name/alt_text) and its presence render on that public surface, so
 * changing or removing it is a Site-gated action a manager may not take. */
const imageHasSiteContentUse = async (imageId: number): Promise<boolean> =>
  (await getImageUsesForImage(imageId)).some((use) =>
    isSiteContentImageType(use.item_type),
  );

/** Block a non-Site session (a manager) from a save that would change an image
 * a news post or page uses — its metadata and links both surface as public Site
 * content. Returns the bounce-back response, or null when the save may proceed.
 * Shared by the edit and delete handlers. */
const siteContentImageGate = async (
  adminLevel: AdminLevel,
  imageId: number,
  redirectTo: string,
): Promise<Response | null> =>
  !isSiteRole(adminLevel) && (await imageHasSiteContentUse(imageId))
    ? redirect(redirectTo, t("images.news_gated"), false)
    : null;

/** The link targets a save may apply. A non-Site session (manager) never
 * attaches a Site-content target — any submitted `news:<id>`/`page:<id>` is
 * dropped. Editing an image that already HAS such a use is blocked outright by
 * {@link siteContentImageGate}, so there are no existing Site links to preserve
 * here. */
const allowedImageTargets = (
  adminLevel: AdminLevel,
  submitted: ImageUseTarget[],
): ImageUseTarget[] =>
  isSiteRole(adminLevel)
    ? submitted
    : submitted.filter((target) => !isSiteContentImageType(target.itemType));

const handleImageEditPost: TypedRouteHandler<"POST /admin/images/:id/edit"> =
  imageHandlers.post(async (image, form, adminLevel) => {
    const blocked = await siteContentImageGate(
      adminLevel,
      image.id,
      imagePath(image.id),
    );
    if (blocked) return blocked;
    const metadata = imageMetadataFromForm(form);
    if (!metadata.ok) {
      return redirect(imagePath(image.id), metadata.error, false);
    }
    await imagesTable.update(image.id, metadata.value);
    await setItemsForImage(
      image.id,
      allowedImageTargets(adminLevel, parseImageTargets(form)),
    );
    await logActivity(`Image '${metadata.value.name}' updated`);
    return redirect(imagePath(image.id), t("images.updated"), true);
  });

const handleImageDeleteGet: TypedRouteHandler<"GET /admin/images/:id/delete"> =
  imageHandlers.get((image, session, request) => {
    applyFlash(request);
    return withStorageEnabled(() =>
      htmlResponse(adminImageDeletePage(image, session)),
    );
  });

const confirmDelete = (form: FormParams, image: Image): string | null =>
  form.getString("confirm_identifier") === image.name
    ? null
    : t("images.delete.mismatch");

const handleImageDeletePost: TypedRouteHandler<"POST /admin/images/:id/delete"> =
  imageHandlers.post(async (image, form, adminLevel) => {
    const deletePath = `/admin/images/${image.id}/delete`;
    // deleteImageRecord prunes every use, including a news one, so a non-Site
    // role may not delete an image a news post uses (public Site content).
    const blocked = await siteContentImageGate(
      adminLevel,
      image.id,
      deletePath,
    );
    if (blocked) return blocked;
    const mismatch = confirmDelete(form, image);
    if (mismatch) return redirect(deletePath, mismatch, false);
    // Delete the stored files first: if storage cleanup fails, keep the DB
    // record so the admin can retry, rather than orphaning the files under a
    // deleted record with no library entry to delete them from.
    try {
      await deleteImageStorageFilesStrict(image);
    } catch {
      return redirect(deletePath, t("images.delete.storage_failed"), false);
    }
    await deleteImageRecord(image.id);
    await logActivity(`Image '${image.name}' deleted`);
    return redirect("/admin/images", t("images.deleted"), true);
  });

export const adminHandlers = defineRoutes({
  "GET /admin/images": handleImagesListGet,
  "GET /admin/images/:id/delete": handleImageDeleteGet,
  "GET /admin/images/:id/edit": handleImageEditGet,
  "GET /admin/images/new": handleImageNewGet,
  "POST /admin/images": handleImageCreatePost,
  "POST /admin/images/:id/delete": handleImageDeletePost,
  "POST /admin/images/:id/edit": handleImageEditPost,
});
