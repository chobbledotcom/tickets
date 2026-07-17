type ImageMagic = {
  readonly bytes: readonly number[];
  readonly offset: number;
};

type ImageFormat = {
  readonly extension: string;
  readonly magic: readonly ImageMagic[];
  readonly uploadable: boolean;
};

/** Every image format the app can recognise. GIF stays readable for legacy
 * files, but cannot be uploaded because the WebP conversion would lose motion. */
export const IMAGE_FORMATS = {
  "image/gif": {
    extension: ".gif",
    magic: [{ bytes: [0x47, 0x49, 0x46, 0x38], offset: 0 }],
    uploadable: false,
  },
  "image/jpeg": {
    extension: ".jpg",
    magic: [{ bytes: [0xff, 0xd8, 0xff], offset: 0 }],
    uploadable: true,
  },
  "image/png": {
    extension: ".png",
    magic: [{ bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 }],
    uploadable: true,
  },
  "image/webp": {
    extension: ".webp",
    magic: [
      { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
      { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
    ],
    uploadable: true,
  },
} as const satisfies Record<string, ImageFormat>;

export type ImageMime = keyof typeof IMAGE_FORMATS;

export type DecodableMime = {
  [Mime in ImageMime]: (typeof IMAGE_FORMATS)[Mime]["uploadable"] extends true
    ? Mime
    : never;
}[ImageMime];

/** Recognised image MIME types in declaration order. */
export const IMAGE_MIMES = Object.keys(IMAGE_FORMATS) as ImageMime[];

const isUploadableImageMime = (mime: ImageMime): mime is DecodableMime =>
  IMAGE_FORMATS[mime].uploadable;

/** MIME types accepted by the image decoder and upload forms. */
export const UPLOADABLE_IMAGE_MIMES = IMAGE_MIMES.filter(isUploadableImageMime);

/** Value for an image file input's `accept` attribute. */
export const IMAGE_UPLOAD_ACCEPT = UPLOADABLE_IMAGE_MIMES.join(",");

/** Whether a MIME type can pass into the image decoder. */
export const canDecodeImageMime = (mime: string): mime is DecodableMime =>
  (UPLOADABLE_IMAGE_MIMES as readonly string[]).includes(mime);
