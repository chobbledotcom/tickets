/**
 * Publish each guide as an MP4 on the CDN, under a name that is the hash of
 * its bytes, plus a small pointer object keyed by the inputs that produced it.
 * A build that finds the pointer and its video already uploaded records
 * nothing: the footage only changes when the screenshots, the storyboard, or
 * the render pipeline change. The app receives the video URLs to bake in.
 */

import {
  type CdnObject,
  publishCdnObjects,
  type StaticCdnConfig,
} from "#scripts/static-cdn.ts";
import type { GuideVideoAssets } from "#shared/guide-video.ts";
import { sha256Hex } from "#shared/sha256.ts";
import { guideVideoBytes } from "./build.ts";
import {
  EVIDENCE_MANIFEST,
  evidenceFingerprints,
  readEvidenceManifest,
} from "./evidence.ts";
import { parseGuideStoryboard, storyboardEvidence } from "./storyboard.ts";
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

export interface PublishGuideVideosOptions {
  /** The anchors the caller already loaded, keyed by guide slug. Defaults to a
   * fresh read of reports/evidence/manifest.json. */
  anchors?: GuideAnchors;
  fetcher?: typeof fetch;
  fromSession?: string;
  /** Produce the MP4 bytes for one guide. Defaults to a real record, render,
   * and encode. Tests inject a fake so they never start a browser. */
  render?: (slug: string) => Promise<Uint8Array>;
  slug?: string;
}

export interface PublishedGuideVideos {
  slugs: readonly string[];
  videos: GuideVideoAssets;
}

const anchorsFromEvidence = async (
  slugs: readonly string[],
): Promise<GuideAnchors> => {
  const manifest = await readEvidenceManifest(EVIDENCE_MANIFEST);
  const entries = await Promise.all(
    slugs.map(async (slug) => {
      const storyboard = parseGuideStoryboard(guideStoryboard(slug));
      const anchors = await evidenceFingerprints(
        manifest,
        EVIDENCE_MANIFEST,
        storyboardEvidence(storyboard),
      );
      return [slug, anchors] as const;
    }),
  );
  return Object.fromEntries(entries);
};

const publicUrlFor = (config: StaticCdnConfig, path: string): string =>
  `${config.cdnUrl}/${path}`;

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
        `${slug}: ignoring the unusable pointer at ${pointerUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    });
  if (pointer === null || pointer.inputs !== inputsHash) return null;
  const head = await fetcher(publicUrlFor(config, pointer.video), {
    method: "HEAD",
  });
  await head.body?.cancel();
  return head.ok ? pointer.video : null;
};

export const publishGuideVideos = async (
  config: StaticCdnConfig,
  options: PublishGuideVideosOptions = {},
): Promise<PublishedGuideVideos> => {
  const slugs = options.slug === undefined ? GUIDE_SLUGS : [options.slug];
  if (options.fromSession !== undefined && slugs.length !== 1) {
    throw new Error("--from takes exactly one guide");
  }
  const fetcher = options.fetcher ?? fetch;
  const anchors = options.anchors ?? (await anchorsFromEvidence(slugs));
  const render =
    options.render ??
    ((slug: string) =>
      guideVideoBytes({
        ...(options.fromSession === undefined
          ? {}
          : { fromSession: options.fromSession }),
        slug,
      }));

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
