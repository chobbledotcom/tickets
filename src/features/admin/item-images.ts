/**
 * Shared image-tab loaders and handlers for image_uses-backed entities.
 */

import { logActivity } from "#db/activity-log.ts";
import {
  appendImageToItem,
  arrangeItemImages,
  getAllImages,
  getImagesForItem,
  imageUseTargets,
  setImagesForItem,
} from "#db/images.ts";
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
import type { FormParams } from "#shared/form-data.ts";
import type { IdRow } from "#shared/ordered-list.ts";
import {
  type OrderedListRoutes,
  orderedListRoutes,
} from "#shared/ordered-list-routes.ts";
import { IMAGE_ORDERS } from "#shared/ordered-lists.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { ItemImagesPanel } from "#templates/admin/images.tsx";
import type { ImageUseItemType } from "#types";
import { withUploadedImage } from "./image-upload.ts";

/** The record facts every image panel needs. */
export type ImagePanelRecord<T> = {
  itemType: ImageUseItemType;
  load: (id: number) => Promise<T | null>;
  nameOf: (item: T) => string;
};

type ItemImageConfig<T> = {
  /** Who can edit this entity's images. Defaults to the content gates.
   * Entities under the Site tab pass the site gates, so managers stay
   * excluded there. */
  auth?: { form: AuthPolicy<"form">; multipart: AuthPolicy<"multipart"> };
  disabledPath: (id: number) => string;
  path: (id: number) => string;
} & ImagePanelRecord<T>;

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
    reorder: IMAGE_ORDERS[itemType].column(itemId),
    uploadAction: `${path}/images/upload`,
  });
};

const selectedImageIds = (form: FormParams): number[] =>
  form.getNumberArray("imageIds");

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

/** The image handlers of one kind of record: save the chosen images, and
 *  upload one. */
export type ItemImageHandlers = {
  set: RouteHandlerFn;
  upload: RouteHandlerFn;
};

/** How one kind of record reads and stores the order of its images. */
const imageOrderStore = (itemType: ImageUseItemType) => ({
  arrange: (images: readonly IdRow[], itemId: number): Promise<void> =>
    arrangeItemImages(
      imageUseTargets.of(itemType)(itemId),
      images.map((image) => image.id),
    ),
  rows: (itemId: number) => getImagesForItem(itemType, itemId),
});

/** The row path of one kind of record's ordered images. */
type ImageRowPath<Kind extends ImageUseItemType> =
  (typeof IMAGE_ORDERS)[Kind]["rowPath"];

/** The routes that move one image of a record before or after another. The
 *  arrows and a drop use them. */
export const imageOrderRoutes = <Kind extends ImageUseItemType>(
  kind: Kind,
): OrderedListRoutes<ImageRowPath<Kind>> =>
  orderedListRoutes<ImageRowPath<ImageUseItemType>, IdRow, number>(
    IMAGE_ORDERS[kind],
    imageOrderStore(kind),
  );

export const createItemImageHandlers = <T>(
  config: ItemImageConfig<T>,
): ItemImageHandlers => {
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
      await setImagesForItem({
        imageIds: selectedImageIds(form),
        itemId,
        itemType: config.itemType,
      });
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
        await appendImageToItem(
          image.id,
          imageUseTargets.of(config.itemType)(itemId),
        );
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
