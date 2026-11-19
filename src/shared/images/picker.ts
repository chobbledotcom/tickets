// effects: pure
/**
 * The markdown editor's image picker, as the server and the browser both
 * see it. It holds the library list, the template id, and the notes that
 * the picker shows in place of thumbnails.
 */

import * as v from "valibot";

/** One library image that the picker offers. The id names its short-form
 * address, and the name becomes the alt text. The grid shows the `thumb`
 * address, and the rich editor shows the `full` address. */
const ImageOptionSchema = v.object({
  full: v.string(),
  id: v.number(),
  name: v.string(),
  thumb: v.string(),
});

/** The `GET /admin/images/options` answer. */
export const ImageOptionsReplySchema = v.object({
  images: v.array(ImageOptionSchema),
});

export type ImageOption = v.InferOutput<typeof ImageOptionSchema>;

/** The id of the `<template>` that holds the picker's markup. A page without
 * it has no image storage. */
export const IMAGE_PICKER_ID = "md-image-picker";

/** The notes that the picker's grid can show in place of thumbnails. */
export const PICKER_NOTES = ["empty", "loading", "uploadFailed"] as const;

export type PickerNote = (typeof PICKER_NOTES)[number];

/** The first nine thumbnails on a page load with it. From the tenth, the
 * browser waits until the reader scrolls near it. The image library and the
 * picker share the count. */
export const LAZY_THUMBNAIL_FROM = 9;
