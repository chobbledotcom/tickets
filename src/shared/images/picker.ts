import { getImageProxyUrl } from "#shared/image-proxy-url.ts";

/** One image the admin image picker shows. It carries the library id and
 *  name, the thumbnail for its grid cell, and the full picture. */
export interface ImagePickerOption {
  id: number;
  name: string;
  thumb: string;
  url: string;
}

/** The stored image's picker facts. */
type PickerImage = {
  filename: string;
  filenameThumb: string;
  id: number;
  name: string;
};

/** Map stored images to the picker's options. Keep their order. */
export const imagePickerOptions = (
  images: readonly PickerImage[],
): ImagePickerOption[] =>
  images.map(({ filename, filenameThumb, id, name }) => ({
    id,
    name,
    thumb: getImageProxyUrl(filenameThumb),
    url: getImageProxyUrl(filename),
  }));
