/** The guide CDN base for the running server. The edge build inlines
 * GUIDE_CDN_BASE. A local run can set the environment to preview the player. */
import { GUIDE_CDN_BASE } from "#shared/asset-paths.ts";
import { resolveGuideCdnBase } from "#shared/guide-video.ts";

export const currentGuideCdnBase = (): string | null =>
  resolveGuideCdnBase(GUIDE_CDN_BASE, process.env.GUIDE_CDN_BASE);
