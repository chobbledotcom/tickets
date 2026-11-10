/**
 * The rules both surfaces of the image library share: the order the library
 * lists its images in, and which links sit on public Site content.
 */

import { compareByName } from "#shared/name-order.ts";
import type { Image, ImageUseItemType } from "#types";

/** The image library's order: name ascending, then upload order. A row id
 * grows as records are created, so the lower id is the older upload. */
export const byNameThenUpload = (first: Image, second: Image): number =>
  compareByName(first, second) || first.id - second.id;

/** The link kinds that are public Site content: news posts and pages. An
 * image on either shows to visitors, so a manager never manages it. */
export const isSiteContentImageType = (type: ImageUseItemType): boolean =>
  type === "news" || type === "page";
