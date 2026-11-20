/**
 * The single decision that a new-listing form shows the Images field, and
 * that its create accepts the chosen ids.
 */

import { newListingCollectsImages } from "#shared/listing-templates.ts";
import { isStorageEnabled } from "#shared/storage.ts";

/** Whether this template's new-listing form collects pictures. */
export const listingImagesEnabled = (
  templateId: string | null | undefined,
): boolean => newListingCollectsImages(templateId) && isStorageEnabled();
