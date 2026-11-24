/** Every tutorial this repository can record. Adding a guide is a new file
 * here and a baseline beside it; the recorder and the check need no change. */

import type { GuideStoryboard } from "../storyboard.ts";
import { createListingGuide } from "./create-listing.ts";

export const GUIDE_STORYBOARDS = [createListingGuide] as const;

export const guideStoryboard = (slug: string): GuideStoryboard => {
  const found = GUIDE_STORYBOARDS.find((guide) => guide.slug === slug);
  if (!found) {
    throw new Error(
      `Unknown guide ${slug}. Choose ${GUIDE_STORYBOARDS.map(({ slug }) => slug).join(", ")}.`,
    );
  }
  return found;
};

export const GUIDE_SLUGS = GUIDE_STORYBOARDS.map(({ slug }) => slug);
