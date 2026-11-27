/**
 * The identity of one rendered guide video. Two decisions live here, kept pure
 * so the publish step and its tests share them: the storage name of the MP4
 * (a hash of its bytes) and the small pointer object that lets a later build
 * skip recording when the pixels it would produce have not changed.
 */

import * as v from "valibot";
import { sha256Hex } from "#shared/sha256.ts";
import { parserFor } from "./schema-parts.ts";

/** Bump when recording, rendering, or encoding changes the pixels. The value
 * is part of the pointer hash, so a pointer written by an older pipeline can
 * never point a build at footage the current pipeline would not produce. */
export const GUIDE_PIPELINE_VERSION = 2;

/** Record and render at double device pixels: a 1280 by 720 viewport becomes a
 * 2560 by 1440 video. A focus zoom up to 2x then samples the recorded frame at
 * one texture pixel per video pixel, so the zoomed text stays sharp. */
export const GUIDE_DEVICE_SCALE_FACTOR = 2;

/** How many hex characters of a digest name a CDN object. */
const HASH_CHARS = 16;

const HASH_PATTERN = /^[a-f0-9]{16}$/;
const VIDEO_PATH_PATTERN =
  /^guides\/[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{16}\.mp4$/;

/** The pointer object a build reads before it spends minutes rendering. It
 * names the inputs the video was made from and the object that holds it. */
export interface GuideVideoPointer {
  inputs: string;
  schemaVersion: 1;
  video: string;
}

const PointerSchema = v.strictObject({
  inputs: v.pipe(v.string(), v.regex(HASH_PATTERN, "Invalid inputs hash")),
  schemaVersion: v.literal(1),
  video: v.pipe(v.string(), v.regex(VIDEO_PATH_PATTERN, "Invalid video path")),
});

export const parseGuideVideoPointer: (input: unknown) => GuideVideoPointer =
  parserFor(PointerSchema);

/** What decides whether a guide's footage is still current: the evidence
 * screenshot hashes it was anchored to, the storyboard that drove it, and the
 * pipeline version. */
export interface GuideVideoInputs {
  anchors: Readonly<Record<string, string>>;
  slug: string;
  storyboard: string;
}

/** The hash of the inputs. A change to any anchored screenshot, to the story,
 * or to the pipeline produces a different hash, so no existing pointer
 * matches and the build renders again. */
export const guideVideoInputsHash = async ({
  anchors,
  slug,
  storyboard,
}: GuideVideoInputs): Promise<string> =>
  (
    await sha256Hex(
      JSON.stringify({
        anchors: Object.keys(anchors)
          .sort()
          .map((captureId) => [captureId, anchors[captureId]]),
        pipeline: GUIDE_PIPELINE_VERSION,
        slug,
        storyboard,
      }),
    )
  ).slice(0, HASH_CHARS);

/** One artifact's place under the guide folder: its subfolder and its file
 * extension. */
interface GuidePathShape {
  extension: string;
  folder: string;
}

/** The name of one guide artifact: its slug, then the key that names it. */
const guidePath = (
  { extension, folder }: GuidePathShape,
  slug: string,
  key: string,
): string => `guides/${folder}${slug}-${key}${extension}`;

const VIDEO_PATH_SHAPE: GuidePathShape = { extension: ".mp4", folder: "" };
const POINTER_PATH_SHAPE: GuidePathShape = {
  extension: ".json",
  folder: "pointers/",
};

/** The storage path of one video, relative to the CDN zone root. The name is
 * the content hash, so two sites on different releases can point at different
 * objects and neither can overwrite the other's footage. */
export const guideVideoObjectPath = (slug: string, digest: string): string =>
  guidePath(VIDEO_PATH_SHAPE, slug, digest.slice(0, HASH_CHARS));

/** The storage path of the pointer for one set of inputs. */
export const guideVideoPointerPath = (
  slug: string,
  inputsHash: string,
): string => guidePath(POINTER_PATH_SHAPE, slug, inputsHash);
