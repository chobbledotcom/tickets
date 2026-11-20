// effects: pure
/**
 * The image picker, as the server and the browser both see it. It holds the
 * library list, the template id, and the notes that the picker shows in
 * place of thumbnails.
 */

import * as v from "valibot";
import { map } from "#fp";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";

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

/** The image facts that a picker hands back: the id a reference names and
 *  the name it shows. */
export type ImageChoice = Pick<ImageOption, "id" | "name">;

/** One image the operator chose for a list: its id, its name, and the
 *  thumbnail the list cell shows. The thumbnail is empty until the library
 *  lists the image. */
export type ChosenImage = ImageChoice & Pick<ImageOption, "thumb">;

/** The stored image facts the picker needs: its name and thumbnail. */
export type PickerImage = {
  filenameThumb: string;
  id: number;
  name: string;
};

/** The stored image facts plus the full picture address. */
type StoredImage = PickerImage & { filename: string };

/** The choice for one stored image. */
const imageChoiceOf = ({
  filenameThumb,
  id,
  name,
}: PickerImage): ChosenImage => ({
  id,
  name,
  thumb: getImageProxyUrl(filenameThumb),
});

/** Map stored images to the choices a list shows. Keep their order. */
export const imageChoicesOf = (images: readonly PickerImage[]): ChosenImage[] =>
  map(imageChoiceOf)(images);

/** Map stored images to the picker's options. Keep their order. */
export const imageOptionsOf = (images: readonly StoredImage[]): ImageOption[] =>
  images.map((image) => ({
    ...imageChoiceOf(image),
    full: getImageProxyUrl(image.filename),
  }));

/** The id of the `<template>` that holds the picker's markup. A page without
 * it has no image storage. */
export const IMAGE_PICKER_ID = "md-image-picker";

/** The `data-copy` name of the template's title. The picker's window shows
 * these words in its title bar. */
export const PICKER_TITLE_COPY = "title";

/** The notes that the picker's grid can show in place of thumbnails. */
export const PICKER_NOTES = [
  "empty",
  "loading",
  "loadFailed",
  "uploadFailed",
] as const;

export type PickerNote = (typeof PICKER_NOTES)[number];

/** The page-level event that says the image library changed. Every picker
 *  drops its cached list when it fires. */
export const IMAGE_LIBRARY_CHANGED = "image-library-changed";

/** The first nine thumbnails on a page load with it. From the tenth, the
 * browser waits until the reader scrolls near it. The image library and the
 * picker share the count. */
export const LAZY_THUMBNAIL_FROM = 9;
