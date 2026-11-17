/**
 * The rules both surfaces of the image library share: the order the library
 * lists its images in, and which links sit on public Site content.
 */

import { getImageUsesForImage } from "#db/images.ts";
import { compareByName } from "#shared/name-order.ts";
import {
  type AdminLevel,
  type Image,
  type ImageUseItemType,
  isSiteRole,
} from "#types";

/** The image library's order: name ascending, then upload order. A row id
 * grows as records are created, so the lower id is the older upload. */
export const byNameThenUpload = (first: Image, second: Image): number =>
  compareByName(first, second) || first.id - second.id;

/** The link kinds that are public Site content: news posts and pages. An
 *  image on either shows to visitors, so a manager never manages it. */
export const isSiteContentImageType = (type: ImageUseItemType): boolean =>
  type === "news" || type === "page";

/** Does this image sit on any public Site content? Its name, its alt text,
 *  and its presence all render there. */
const imageHasSiteContentUse = async (imageId: number): Promise<boolean> =>
  (await getImageUsesForImage(imageId)).some((use) =>
    isSiteContentImageType(use.item_type),
  );

/** Somebody below a Site role cannot manage an image that public Site content
 *  shows. The surface answers the refusal its own way. */
export const siteContentBlocksManager = async (
  adminLevel: AdminLevel,
  imageId: number,
): Promise<boolean> =>
  !isSiteRole(adminLevel) && (await imageHasSiteContentUse(imageId));

/** Run a surface's refusal when public Site content blocks the image. */
export const whenSiteContentBlocksManager = async (
  adminLevel: AdminLevel,
  imageId: number,
  refusal: Response,
): Promise<Response | null> =>
  (await siteContentBlocksManager(adminLevel, imageId)) ? refusal : null;
