/**
 * Publish each guide as an MP4 on the CDN, under a name that is the hash of
 * its bytes, plus a small pointer object keyed by the inputs that produced it.
 * A build that finds the pointer and its video already uploaded records
 * nothing: the footage only changes when the screenshots, the storyboard, or
 * the render pipeline change. The app receives the video URLs to bake in.
 *
 * Every input arrives from the caller, so the module holds no browser, no
 * evidence file, and no process state: `publish.ts` supplies the real
 * recorder, and the tests supply a fake.
 */

import {
  type CdnObject,
  publicUrlFor,
  publishCdnObjects,
  type StaticCdnConfig,
} from "#scripts/static-cdn.ts";
import type { GuideVideoAssets } from "#shared/guide-video.ts";
import { sha256Hex } from "#shared/sha256.ts";
import { parseGuideStoryboard } from "./storyboard.ts";
import { GUIDE_SLUGS, guideStoryboard } from "./storyboards/index.ts";
import {
  guideVideoInputsHash,
  guideVideoObjectPath,
  guideVideoPointerPath,
  parseGuideVideoPointer,
} from "./video.ts";

const MP4 = "video/mp4";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const POINTER_SCHEMA_VERSION = 1;

/** The evidence screenshot hashes for each guide, keyed by capture id. A build
 * that has not run the evidence capture cannot tell whether the footage is
 * current, so the lookup fails loudly rather than re-rendering blind. */
export type GuideAnchors = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

export interface PublishVideosOptions {
  anchors: GuideAnchors;
  fetcher: typeof fetch;
  /** Produce the MP4 bytes for one guide. */
  render: (slug: string) => Promise<Uint8Array>;
  slug?: string | undefined;
}

export interface PublishedGuideVideos {
  slugs: readonly string[];
  videos: GuideVideoAssets;
}

/** The uploaded video for these inputs, when an earlier build already made it.
 * Any unreadable or unverifiable pointer is a miss, because re-rendering is
 * always correct — only the recording time is lost. */
const existingVideoPath = async (
  config: StaticCdnConfig,
  fetcher: typeof fetch,
  slug: string,
  inputsHash: string,
): Promise<string | null> => {
  const pointerUrl = publicUrlFor(
    config,
    guideVideoPointerPath(slug, inputsHash),
  );
  const response = await fetcher(pointerUrl);
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const pointer = await response
    .json()
    .then(parseGuideVideoPointer)
    .catch((error: unknown) => {
      console.warn(
        `${slug}: ignoring the unusable pointer at ${pointerUrl}`,
        error,
      );
      return null;
    });
  if (pointer === null || pointer.inputs !== inputsHash) return null;
  const videoUrl = publicUrlFor(config, pointer.video);
  const head = await fetcher(videoUrl, { method: "HEAD" });
  await head.body?.cancel();
  return head.ok ? pointer.video : null;
};

export const publishVideos = async (
  config: StaticCdnConfig,
  options: PublishVideosOptions,
): Promise<PublishedGuideVideos> => {
  const slugs = options.slug === undefined ? GUIDE_SLUGS : [options.slug];
  const { anchors, fetcher, render } = options;
  const videos: Record<string, { video: string }> = {};
  for (const slug of slugs) {
    const slugAnchors = anchors[slug];
    if (slugAnchors === undefined) {
      throw new Error(
        `No screenshot anchors for ${slug}. Run "deno task specs:evidence" first.`,
      );
    }
    const storyboard = parseGuideStoryboard(guideStoryboard(slug));
    const inputsHash = await guideVideoInputsHash({
      anchors: slugAnchors,
      slug,
      storyboard: JSON.stringify(storyboard),
    });
    const existing = await existingVideoPath(config, fetcher, slug, inputsHash);
    if (existing !== null) {
      console.log(`${slug}: footage unchanged, reusing ${existing}`);
      videos[slug] = { video: publicUrlFor(config, existing) };
      continue;
    }
    const bytes = await render(slug);
    const objectPath = guideVideoObjectPath(slug, await sha256Hex(bytes));
    const pointerPath = guideVideoPointerPath(slug, inputsHash);
    const objects: CdnObject[] = [
      { bytes, contentType: MP4, path: objectPath },
      {
        bytes: new TextEncoder().encode(
          `${JSON.stringify(
            {
              inputs: inputsHash,
              schemaVersion: POINTER_SCHEMA_VERSION,
              video: objectPath,
            },
            null,
            2,
          )}\n`,
        ),
        contentType: JSON_CONTENT_TYPE,
        path: pointerPath,
      },
    ];
    await publishCdnObjects(config, objects, fetcher);
    console.log(`${slug}: uploaded ${objectPath}`);
    videos[slug] = { video: publicUrlFor(config, objectPath) };
  }
  return { slugs, videos };
};
