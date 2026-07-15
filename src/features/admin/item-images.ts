/**
 * Shared image-tab loaders and handlers for image_uses-backed entities.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  type AuthPolicy,
  CONTENT_FORM,
  CONTENT_MULTIPART,
  formGuard,
  withAuth,
} from "#routes/auth.ts";
import { createEntityHandler, withEntity } from "#routes/entity.ts";
import { redirect } from "#routes/response.ts";
import type { RouteHandlerFn, RouteParams } from "#routes/router.ts";
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
import { withUploadedImage } from "./image-upload.ts";

/* jscpd:ignore-end */

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

const withStorageBackedItem =
  <T>(config: ItemImageConfig<T>) =>
  (
    item: T,
    itemId: number,
    action: (item: T, itemId: number) => Promise<Response>,
  ): Promise<Response> =>
    isStorageEnabled()
      ? action(item, itemId)
      : Promise.resolve(storageDisabledResponse(config, itemId));

export const createItemImageHandlers = <T>(
  config: ItemImageConfig<T>,
): {
  set: RouteHandlerFn;
  upload: RouteHandlerFn;
} => {
  const itemHandler = createEntityHandler<RouteParams, T>(({ id }) =>
    config.load(Number(id)),
  );
  const withItem = withStorageBackedItem(config);
  const itemAction =
    <Body>(
      action: (body: Body, item: T, itemId: number) => Promise<Response>,
    ) =>
    (body: Body, item: T, id: string | number | undefined): Promise<Response> =>
      withItem(item, Number(id), (loaded, itemId) =>
        action(body, loaded, itemId),
      );
  const setItem = itemAction(
    async (form: FormParams, item: T, itemId: number) => {
      await setImagesForItem(config.itemType, itemId, selectedImageIds(form));
      await logActivity(
        `Images updated for ${config.itemType} '${config.nameOf(item)}'`,
      );
      return redirect(config.path(itemId), t("images.item.saved"), true);
    },
  );
  const uploadItem = itemAction(
    async (formData: FormData, item: T, itemId: number) => {
      const itemPath = config.path(itemId);
      return withUploadedImage(formData, itemPath, async (image) => {
        await appendImageToItem(image.id, {
          itemId,
          itemType: config.itemType,
        });
        await logActivity(
          `Image '${image.name}' uploaded for ${config.itemType} '${config.nameOf(
            item,
          )}'`,
        );
        return redirect(itemPath, t("images.item.uploaded"), true);
      });
    },
  );
  const set = itemHandler(formGuard(config.auth?.form ?? CONTENT_FORM))(
    async (item, _session, form, _request, { id }) => setItem(form, item, id),
  );
  const upload: RouteHandlerFn = (request, { id }) =>
    withAuth(
      request,
      config.auth?.multipart ?? CONTENT_MULTIPART,
      async (_session, formData) =>
        withEntity((item: T) => uploadItem(formData, item, id))(() =>
          config.load(Number(id)),
        ),
    );
  return { set, upload };
};
