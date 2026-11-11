/**
 * The image library's wire shapes: one image row, the records that show it,
 * and the two write bodies. The resource table and every route read them from
 * here. A field the server answers and a field a caller sends then have the
 * same spelling.
 */

import * as v from "valibot";
import { ImageUseItemTypeSchema } from "#types";

/** One malformed link answers the same sentence, whichever field it names. */
const ITEM_REFUSAL =
  "Each link needs an item_type of listing, group, news, page, and a whole item_id";

/** One record an image is linked to: the kind of record and its id. */
const ImageItemRow = {
  item_id: v.number(ITEM_REFUSAL),
  item_type: v.picklist(ImageUseItemTypeSchema.options, ITEM_REFUSAL),
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

/** The body an image create carries. It holds the file bytes as base64 text,
 *  the type the caller declares, and the metadata the library shows. The
 *  messages are the wire answers, so the route and the schema cannot drift. */
export const CreateImageBodySchema = v.object({
  alt_text: v.optional(v.string("alt_text must be a string")),
  content_type: v.pipe(
    v.string("content_type is required"),
    v.trim(),
    v.nonEmpty("content_type is required"),
  ),
  file: v.pipe(
    v.string("file is required"),
    v.trim(),
    v.nonEmpty("file is required"),
  ),
  name: v.string("name must be a string"),
});

/** The create parse view: the same entries, marked optional. Valibot names a
 *  missing key in its own words. The route reads the required fields with the
 *  shared readers and answers each with its own message. */
export const CreateImageBodyParseSchema = v.partial(CreateImageBodySchema);

/** The body an image update carries: every writable field optional. `items`
 *  replaces the records that show the image. An absent key leaves the stored
 *  links alone. */
export const UpdateImageBodySchema = v.partial(
  v.object({
    alt_text: v.string("alt_text must be a string"),
    items: v.array(ImageItemSchema, "items must be an array"),
    name: v.string("name must be a string"),
  }),
);
