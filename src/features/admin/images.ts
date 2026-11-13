import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import type { TypedRouteHandler } from "#routes/router.ts";

/**
 * First-class image library admin routes.
 */

import { groups } from "#db/groups.ts";
import {
  getAllImages,
  getImageById,
  getImageUsesForImage,
  type ImageUseTarget,
  imageUseTargets,
} from "#db/images.ts";
import { getAllListingOptions } from "#db/listings/records.ts";
import { getNewsPostNames } from "#db/news-posts.ts";
import { sitePages } from "#db/site-pages.ts";
import { t } from "#i18n";
import {
  CONTENT_FORM,
  CONTENT_MULTIPART,
  contentPage,
  contentResponsePage,
  formGuard,
  requireContentOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import {
  adminRedirect,
  htmlResponse,
  jsonResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { adminPath } from "#shared/admin-surface.ts";
import type { FormParams } from "#shared/form-data.ts";
import { logImageAction } from "#shared/images/activity.ts";
import {
  byNameThenUpload,
  isSiteContentImageType,
  whenSiteContentBlocksManager,
} from "#shared/images/library.ts";
import { sortByName } from "#shared/name-order.ts";
import { imageRecord } from "#shared/records/images.ts";
import { featureGate, type ResponseHandler } from "#shared/response-steps.ts";
import type { DeleteVerdict, WriteVerdict } from "#shared/rest/record.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { deleteImageStorageFilesStrict } from "#shared/storage-cleanup.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";

import {
  adminImageDeletePage,
  adminImageEditPage,
  adminImageNewPage,
  adminImagesPage,
  type ImageItemOption,
} from "#templates/admin/images.tsx";
import {
  type AdminLevel,
  type Image,
  type ImageUseItemType,
  isImageUseItemType,
  isSiteRole,
} from "#types";
import { imageMetadataFromForm, withUploadedImage } from "./image-upload.ts";

/** The image's edit page: where a create and a save both land. */
const imagePath = (id: number): string => adminPath("imageEdit", { id });

const withStorageEnabled = featureGate(isStorageEnabled, () =>
  adminRedirect("images", {}, t("images.storage_off"), false),
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

const handleImagesListGet: TypedRouteHandler<"GET /admin/images"> = contentPage(
  async (session) =>
    adminImagesPage(
      isStorageEnabled()
        ? sortByName(await getAllImages(), byNameThenUpload)
        : [],
      session,
    ),
);

const handleImageNewGet: TypedRouteHandler<"GET /admin/images/new"> =
  contentResponsePage((session) =>
    withStorageEnabled(() => htmlResponse(adminImageNewPage(session))),
  );

const handleImageCreatePost: TypedRouteHandler<"POST /admin/images"> = (
  request,
) =>
  withAuth(request, CONTENT_MULTIPART, (_session, formData) =>
    withStorageEnabled(() =>
      withUploadedImage(formData, "/admin/images/new", async (image) => {
        await logImageAction("uploaded", image.name);
        return adminRedirect(
          "imageEdit",
          { id: image.id },
          t("images.created"),
          true,
        );
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

/** The link targets this session can manage. News posts and pages are
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
      const id = parsePositiveInt(itemId);
      return isImageUseItemType(itemType) && id !== null
        ? imageUseTargets.of(itemType)(id)
        : null;
    })
    .filter((target): target is ImageUseTarget => target !== null);

/** Block a non-Site session (a manager) from a save that changes an image
 * a news post or page uses. That image's metadata and links both surface as
 * public Site content. Returns the bounce-back response, or null when the
 * save can proceed. Shared by the edit and delete handlers. */
const siteContentImageGate = async (
  adminLevel: AdminLevel,
  imageId: number,
  redirectTo: string,
): Promise<Response | null> =>
  whenSiteContentBlocksManager(
    adminLevel,
    imageId,
    redirect(redirectTo, t("images.news_gated"), false),
  );

/** The link targets a save can apply. A non-Site session (manager) never
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
    : submitted.filter((target) => !isSiteContentImageType(target.kind));

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
      return adminRedirect(
        "imageEdit",
        { id: image.id },
        metadata.error,
        false,
      );
    }
    const verdict = await imageRecord.update(image.id, {
      ...metadata.value,
      filename: image.filename,
      filenameThumb: image.filename_thumb,
      items: allowedImageTargets(adminLevel, parseImageTargets(form)),
    });
    return answerImageWrite(
      verdict,
      () =>
        adminRedirect("imageEdit", { id: image.id }, t("images.updated"), true),
      notFoundResponse,
      (message) => imageRefusalRedirect("imageEdit", image.id, message),
    );
  });

/** Send a refused image write back to its edit or delete page. */
const imageRefusalRedirect = (
  destination: "imageEdit" | "imageDelete",
  id: number,
  message: string,
): Response => adminRedirect(destination, { id }, message, false);

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
    const deletePath = adminPath("imageDelete", { id: image.id });
    // The record delete prunes every use, including a news one, so a non-Site
    // role cannot delete an image a news post uses (public Site content).
    const blocked = await siteContentImageGate(
      adminLevel,
      image.id,
      deletePath,
    );
    if (blocked) return blocked;
    const mismatch = confirmDelete(form, image);
    if (mismatch) {
      return imageRefusalRedirect("imageDelete", image.id, mismatch);
    }
    // Delete the stored files first. If storage cleanup fails, keep the DB
    // record so the admin can retry. Otherwise the files sit orphaned under
    // a deleted record, with no library entry to delete them from.
    try {
      await deleteImageStorageFilesStrict(image);
    } catch {
      return adminRedirect(
        "imageDelete",
        { id: image.id },
        t("images.delete.storage_failed"),
        false,
      );
    }
    const verdict = await imageRecord.remove(image.id);
    return answerImageWrite(
      verdict,
      notFoundResponse,
      () => adminRedirect("images", {}, t("images.deleted"), true),
      (message) => imageRefusalRedirect("imageDelete", image.id, message),
    );
  });

/** The image list the editor's image dropdown offers: every image's id and
 * name, in the library's name order. No URLs or thumbnails — the client needs
 * nothing more to insert the short-form reference. */
const handleImageOptionsGet: TypedRouteHandler<"GET /admin/images/options"> =
  contentResponsePage(async () => {
    const images = isStorageEnabled() ? await getAllImages() : [];
    const options = sortByName(images, byNameThenUpload).map(
      ({ id, name }) => ({ id, name }),
    );
    return jsonResponse({ images: options });
  });

/** Answer one image write: its success redirect, its refusal, or a 404. Each
 *  call passes `notFoundResponse` for the outcome its verdict union cannot
 *  carry: an update never answers "deleted", and a delete never "written". */
const answerImageWrite = async <Row>(
  verdict: WriteVerdict<Row> | DeleteVerdict,
  written: ResponseHandler<[row: Row]>,
  deleted: ResponseHandler,
  refused: ResponseHandler<[message: string]>,
): Promise<Response> => {
  if (verdict.kind === "refused") return refused(verdict.message);
  if (verdict.kind === "not-found") return notFoundResponse();
  if (verdict.kind === "written") return written(verdict.row);
  return deleted();
};

export const adminHandlers = defineAdminRoutes({
  "GET /admin/images": handleImagesListGet,
  "GET /admin/images/:id/delete": handleImageDeleteGet,
  "GET /admin/images/:id/edit": handleImageEditGet,
  "GET /admin/images/new": handleImageNewGet,
  "GET /admin/images/options": handleImageOptionsGet,
  "POST /admin/images": handleImageCreatePost,
  "POST /admin/images/:id/delete": handleImageDeletePost,
  "POST /admin/images/:id/edit": handleImageEditPost,
});
