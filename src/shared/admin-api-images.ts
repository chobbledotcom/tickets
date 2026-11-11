/**
 * The image library's wire shapes: one image row, the records that show it,
 * and the two write bodies. The resource table and every route read them from
 * here. A field the server answers and a field a caller sends then have the
 * same spelling.
 */

import * as v from "valibot";
import { ImageUseItemTypeSchema } from "#types";

/** One record an image is linked to: the kind of record and its id. */
const ImageItemRow = {
  item_id: v.number(),
  item_type: ImageUseItemTypeSchema,
};

/** One image link, on the answer side and the write side alike. */
export const ImageItemSchema = v.object(ImageItemRow);

/** One image as the admin API answers with it: the stored name and alt text,
 *  and the two URLs of its stored files. It also carries the records that
 *  show it. */
export const ImageRowSchema = v.looseObject({
  alt_text: v.string(),
  id: v.number(),
  items: v.array(ImageItemSchema),
  name: v.string(),
  thumb_url: v.string(),
  url: v.string(),
});

/** The body an image create carries: the file's bytes as base64 text, the
 *  type the caller declares for them, and the metadata the library shows. */
export const CreateImageBodySchema = v.object({
  alt_text: v.optional(v.string()),
  content_type: v.string(),
  file: v.string(),
  name: v.string(),
});

/** The body an image update carries: every writable field optional. `items`
 *  replaces the records that show the image. An absent key leaves the stored
 *  links alone. */
export const UpdateImageBodySchema = v.partial(
  v.object({
    alt_text: v.string(),
    items: v.array(ImageItemSchema),
    name: v.string(),
  }),
);
