/**
 * The WebP output variants every uploaded image is transcoded into.
 *
 * Two sizes cover every display context. The full-size image runs on the
 * public listing page and the site header. The thumbnail runs in the admin
 * listings table and the public order-gallery cards. Both are WebP.
 */

import type { ImageTarget } from "./types.ts";

/** Full-size variant: 1600px max width, WebP quality 90. */
export const FULL_IMAGE_TARGET: ImageTarget = { maxWidth: 1600, quality: 90 };

/** Thumbnail variant: 480px max width, WebP quality 80. */
export const THUMB_IMAGE_TARGET: ImageTarget = { maxWidth: 480, quality: 80 };
