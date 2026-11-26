// effects: pure
/**
 * Where the recorded guide videos live. The edge build bakes the map, so a
 * deployed site names the objects its own release uploaded; without a map the
 * admin page renders no camera link at all.
 *
 * The MP4s are silent and content-addressed, so the modal can autoplay them
 * muted and different sites on different releases never share a file.
 */

import * as v from "valibot";

export interface GuideVideoAsset {
  video: string;
}

export type GuideVideoAssets = Readonly<Record<string, GuideVideoAsset>>;

const VideoUrlSchema = v.pipe(
  v.string(),
  v.regex(/^https:\/\/\S+$/, "A guide video needs an absolute HTTPS URL"),
);

const GuideVideoAssetSchema = v.strictObject({ video: VideoUrlSchema });

const GuideVideoAssetsSchema = v.record(
  v.pipe(v.string(), v.nonEmpty()),
  GuideVideoAssetSchema,
);

/** Parse the baked or environment-supplied map. A malformed map fails loudly:
 * a silently empty one would hide the links without anyone noticing. */
export const parseGuideVideoAssets = (input: unknown): GuideVideoAssets =>
  v.parse(GuideVideoAssetsSchema, input);

/** Parse the JSON a developer puts in GUIDE_VIDEOS to preview a published
 * video locally. An absent or empty value means no links. */
export const parseGuideVideoAssetsJson = (
  raw: string | undefined,
): GuideVideoAssets =>
  raw === undefined || raw.trim() === ""
    ? {}
    : parseGuideVideoAssets(JSON.parse(raw));

/** The baked map wins. A local run can supply the same JSON in the
 * environment instead; the edge build inlines the baked value. */
export const resolveGuideVideos = (
  baked: GuideVideoAssets,
  env: string | undefined,
): GuideVideoAssets =>
  Object.keys(baked).length > 0 ? baked : parseGuideVideoAssetsJson(env);

export const guideVideoFor = (
  videos: GuideVideoAssets,
  slug: string,
): GuideVideoAsset | null => videos[slug] ?? null;

/** The origins the page must name in its media policy. Every video is
 * expected on the same CDN, but the policy is derived rather than assumed. */
export const guideVideoOrigins = (
  videos: GuideVideoAssets,
): readonly string[] => [
  ...new Set(Object.values(videos).map(({ video }) => new URL(video).origin)),
];
