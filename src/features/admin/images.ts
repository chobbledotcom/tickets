/**
 * First-class image library admin routes.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import {
  CONTENT_FORM,
  CONTENT_MULTIPART,
  requireContentOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllGroups } from "#shared/db/groups.ts";
import {
  deleteImageRecord,
  getAllImages,
  getImageById,
  getImageUsesForImage,
  type ImageUseTarget,
  imagesTable,
  setItemsForImage,
} from "#shared/db/images.ts";
import { getAllListings } from "#shared/db/listings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { deleteImageStorageFiles, isStorageEnabled } from "#shared/storage.ts";
import { type Image, isImageUseItemType } from "#shared/types.ts";
import {
  adminImageDeletePage,
  adminImageEditPage,
  adminImageNewPage,
  adminImagesPage,
  type ImageItemOption,
} from "#templates/admin/images.tsx";
import { withEntityFromParam } from "./entity-handlers.ts";
import {
  createImageFromUpload,
  imageMetadataFromForm,
} from "./image-upload.ts";

// jscpd:ignore-end

const imagePath = (id: number): string => `/admin/images/${id}/edit`;

const handleImagesListGet: TypedRouteHandler<"GET /admin/images"> = (request) =>
  requireContentOr(request, async (session) => {
    applyFlash(request);
    return htmlResponse(adminImagesPage(await getAllImages(), session));
  });

const handleImageNewGet: TypedRouteHandler<"GET /admin/images/new"> = (
  request,
) =>
  requireContentOr(request, (session) => {
    applyFlash(request);
    return htmlResponse(adminImageNewPage(session));
  });

const handleImageCreatePost: TypedRouteHandler<"POST /admin/images"> = (
  request,
) =>
  withAuth(request, CONTENT_MULTIPART, async (_session, formData) => {
    const result = await createImageFromUpload(formData);
    if (!result.ok) return redirect("/admin/images/new", result.error, false);
    await logActivity(`Image '${result.value.name}' uploaded`);
    return redirect(imagePath(result.value.id), t("images.created"), true);
  });

const listingImageItemOptions = async (): Promise<ImageItemOption[]> =>
  (await getAllListings()).map((listing) => ({
    id: listing.id,
    label: listing.name,
    type: "listing" as const,
  }));

const groupImageItemOptions = async (): Promise<ImageItemOption[]> =>
  (await getAllGroups()).map((group) => ({
    id: group.id,
    label: group.name,
    type: "group" as const,
  }));

const imageItemOptions = async (): Promise<ImageItemOption[]> => [
  ...(await listingImageItemOptions()),
  ...(await groupImageItemOptions()),
];

const selectedUses = async (imageId: number): Promise<Set<string>> =>
  new Set(
    (await getImageUsesForImage(imageId)).map(
      (use) => `${use.item_type}:${use.item_id}`,
    ),
  );

const handleImageEditGet: TypedRouteHandler<"GET /admin/images/:id/edit"> = (
  request,
  { id },
) =>
  requireContentOr(request, (session) =>
    withEntityFromParam(id, getImageById, async (image) => {
      applyFlash(request);
      const [options, selected] = await Promise.all([
        imageItemOptions(),
        selectedUses(image.id),
      ]);
      return htmlResponse(
        adminImageEditPage({ image, options, selected, session }),
      );
    }),
  );

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

const withImageForm = (
  request: Request,
  id: number,
  action: (image: Image, form: FormParams) => Promise<Response>,
): Promise<Response> =>
  withAuth(request, CONTENT_FORM, (_session, form) =>
    withEntityFromParam(id, getImageById, (image) => action(image, form)),
  );

const handleImageEditPost: TypedRouteHandler<"POST /admin/images/:id/edit"> = (
  request,
  { id },
) =>
  withImageForm(request, id, async (image, form) => {
    const metadata = imageMetadataFromForm(form);
    if (!metadata.ok) {
      return redirect(imagePath(image.id), metadata.error, false);
    }
    await imagesTable.update(image.id, metadata.value);
    await setItemsForImage(image.id, parseImageTargets(form));
    await logActivity(`Image '${metadata.value.name}' updated`);
    return redirect(imagePath(image.id), t("images.updated"), true);
  });

const handleImageDeleteGet: TypedRouteHandler<
  "GET /admin/images/:id/delete"
> = (request, { id }) =>
  requireContentOr(request, (session) =>
    withEntityFromParam(id, getImageById, (image) => {
      applyFlash(request);
      return htmlResponse(adminImageDeletePage(image, session));
    }),
  );

const confirmDelete = (form: FormParams, image: Image): string | null =>
  form.getString("confirm_identifier") === image.name
    ? null
    : t("images.delete.mismatch");

const handleImageDeletePost: TypedRouteHandler<
  "POST /admin/images/:id/delete"
> = (request, { id }) =>
  withImageForm(request, id, async (image, form) => {
    const mismatch = confirmDelete(form, image);
    if (mismatch) {
      return redirect(`/admin/images/${image.id}/delete`, mismatch, false);
    }
    if (isStorageEnabled()) {
      await deleteImageStorageFiles(image, "image deletion");
    }
    await deleteImageRecord(image.id);
    await logActivity(`Image '${image.name}' deleted`);
    return redirect("/admin/images", t("images.deleted"), true);
  });

export const imagesRoutes = defineRoutes({
  "GET /admin/images": handleImagesListGet,
  "GET /admin/images/:id/delete": handleImageDeleteGet,
  "GET /admin/images/:id/edit": handleImageEditGet,
  "GET /admin/images/new": handleImageNewGet,
  "POST /admin/images": handleImageCreatePost,
  "POST /admin/images/:id/delete": handleImageDeletePost,
  "POST /admin/images/:id/edit": handleImageEditPost,
});
