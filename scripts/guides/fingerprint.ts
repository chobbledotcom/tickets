/** Read a screenshot as the 32 by 32 greyscale thumbnail that the edge hash
 * reads. Greyscale keeps a colour change alone from looking like a layout
 * change. */

import sharp from "sharp";
import { edgeHash, THUMBNAIL_SIDE } from "./edge-hash.ts";

export const fingerprintPng = async (bytes: Uint8Array): Promise<string> =>
  edgeHash(
    new Uint8Array(
      await sharp(bytes)
        .resize(THUMBNAIL_SIDE, THUMBNAIL_SIDE, { fit: "fill" })
        .greyscale()
        .raw()
        .toBuffer(),
    ),
  );
