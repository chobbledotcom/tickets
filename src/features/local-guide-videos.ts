/**
 * The local guide video route. A development run reports each recorded MP4 at
 * `/guide-videos/<slug>`, and this route reads it from `reports/guides/`. A
 * build that published its videos names absolute CDN URLs, so it answers 404
 * here and never reads a file.
 */

import { join } from "@std/path";
import type { TypedRouteHandler } from "#routes/router.ts";
import { guideVideoFor } from "#shared/guide-video.ts";
import { currentGuideVideos } from "#shared/guide-videos.ts";

/** Where the recorder writes one guide's MP4, relative to the working tree. */
const GUIDE_VIDEO_DIR = "reports/guides";

/** The site path that the development map names for one local video. */
const localGuideVideoPath = (slug: string): string => `/guide-videos/${slug}`;

/** One guide's MP4 bytes, or null when the recorder has not written it. */
const readLocalGuideVideo = async (
  slug: string,
): Promise<Uint8Array | null> => {
  try {
    return await Deno.readFile(join(GUIDE_VIDEO_DIR, slug, "guide.mp4"));
  } catch (error) {
    // A guide that was never recorded is a genuine 404, not a broken site.
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
};

export const handleLocalGuideVideo: TypedRouteHandler<
  "GET /guide-videos/:slug"
> = async (_request, { slug }) => {
  const video = guideVideoFor(currentGuideVideos(), slug);
  if (video?.video !== localGuideVideoPath(slug)) {
    return new Response(null, { status: 404 });
  }
  const bytes = await readLocalGuideVideo(slug);
  return bytes === null
    ? new Response(null, { status: 404 })
    : new Response(bytes.buffer as BodyInit, {
        headers: { "content-type": "video/mp4" },
      });
};
