/** The guide videos for the running server. The edge build inlines
 * GUIDE_VIDEOS; a local run can set the same JSON in the environment to
 * preview a published video. */
import { GUIDE_VIDEOS } from "#shared/asset-paths.ts";
import {
  type GuideVideoAssets,
  resolveGuideVideos,
} from "#shared/guide-video.ts";

export const currentGuideVideos = (): GuideVideoAssets =>
  resolveGuideVideos(GUIDE_VIDEOS, process.env.GUIDE_VIDEOS);
