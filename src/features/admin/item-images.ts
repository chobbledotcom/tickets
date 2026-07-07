/**
 * Shared image-tab loaders and handlers for image_uses-backed entities.
 */

import { t } from "#i18n";
import {
  type AuthPolicy,
  CONTENT_FORM,
  CONTENT_MULTIPART,
  withAuth,
} from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  appendImageToItem,
  getAllImages,
  getImagesForItem,
  setImagesForItem,
} from "#shared/db/images.ts";
import type { FormParams } from "#shared/form-data.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import type { ImageUseItemType } from "#shared/types.ts";
import { ItemImagesPanel } from "#templates/admin/images.tsx";
import { withEntityFromParam } from "./entity-handlers.ts";
import { withUploadedImage } from "./image-upload.ts";

type ItemImageConfig<T> = {
  /** Who may edit this entity's images. Defaults to the content gates; entities
   * under the Site tab pass the site gates so managers stay excluded there. */
  auth?: { form: AuthPolicy<"form">; multipart: AuthPolicy<"multipart"> };
  disabledPath: (id: number) => string;
  itemType: ImageUseItemType;
  load: (id: number) => Promise<T | null>;
  nameOf: (item: T) => string;
  path: (id: number) => string;
};

export const loadItemImagesPanel = async (
  itemType: ImageUseItemType,
  itemId: number,
  path: string,
): Promise<JSX.Element> => {
  const [linkedImages, allImages] = await Promise.all([
    getImagesForItem(itemType, itemId),
    getAllImages(),
  ]);
  return ItemImagesPanel({
    action: `${path}/images`,
    allImages,
    linkedImages,
    uploadAction: `${path}/images/upload`,
  });
};

const selectedImageIds = (form: FormParams): number[] =>
  form.getNumberArray("image_ids");

const storageDisabledResponse = <T>(
  config: ItemImageConfig<T>,
  itemId: number,
): Response =>
  redirect(config.disabledPath(itemId), t("images.storage_off"), false);

const withStorageBackedItem = <T>(
  id: string | number | undefined,
  config: ItemImageConfig<T>,
  action: (item: T, itemId: number) => Promise<Response>,
): Promise<Response> =>
  withEntityFromParam(Number(id), config.load, (item) => {
    const itemId = Number(id);
    return isStorageEnabled()
      ? action(item, itemId)
      : storageDisabledResponse(config, itemId);
  });

export const createItemImageHandlers = <T>(
  config: ItemImageConfig<T>,
): {
  set: RouteHandlerFn;
  upload: RouteHandlerFn;
} => ({
  set: (request, { id }) =>
    withAuth(
      request,
      config.auth?.form ?? CONTENT_FORM,
      (_session, form) =>
        withStorageBackedItem(id, config, async (item, itemId) => {
          await setImagesForItem(
            config.itemType,
            itemId,
            selectedImageIds(form),
          );
          await logActivity(
            `Images updated for ${config.itemType} '${config.nameOf(item)}'`,
          );
          return redirect(config.path(itemId), t("images.item.saved"), true);
        }),
    ),
  upload: (request, { id }) =>
    withAuth(
      request,
      config.auth?.multipart ?? CONTENT_MULTIPART,
      async (_session, formData) =>
        withStorageBackedItem(id, config, async (item, itemId) => {
          const itemPath = config.path(itemId);
          return withUploadedImage(formData, itemPath, async (image) => {
            await appendImageToItem(image.id, {
              itemId,
              itemType: config.itemType,
            });
            await logActivity(
              `Image '${image.name}' uploaded for ${config.itemType} '${
                config.nameOf(
                  item,
                )
              }'`,
            );
            return redirect(itemPath, t("images.item.uploaded"), true);
          });
        }),
    ),
});
