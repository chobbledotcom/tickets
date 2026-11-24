/**
 * What a published guide used at the moment it was recorded. The committed
 * baseline is the only thing the freshness check needs from the video, so a
 * reader can see which Cucumber captures the video was built from without
 * carrying the video itself in the repository.
 */

import * as v from "valibot";
import { SCREENSHOT_PROFILE_NAMES } from "#scripts/screenshots/profile.ts";
import type { GuideFingerprint } from "./fingerprint.ts";

import {
  NonEmptyTextSchema,
  parseDocument,
  StableIdSchema,
} from "./schema-parts.ts";

const HEX_SHA_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export interface GuideBaselineAnchor extends GuideFingerprint {
  captureId: string;
  caseId: string;
}

export interface GuideFreshnessBaseline {
  anchors: readonly GuideBaselineAnchor[];
  evidenceCommit: string;
  guide: { slug: string; title: string };
  profile: (typeof SCREENSHOT_PROFILE_NAMES)[number];
  recordedCommit: string;
  schemaVersion: 1;
}

const AnchorSchema = v.strictObject({
  captureId: StableIdSchema,
  caseId: StableIdSchema,
  grayscale: v.pipe(v.string(), v.nonEmpty()),
  sha256: v.pipe(v.string(), v.regex(HEX_SHA_PATTERN, "Invalid sha256")),
});

/* jscpd:ignore-start -- the baseline document is static data */
const BaselineSchema = v.strictObject({
  anchors: v.pipe(v.array(AnchorSchema), v.minLength(1)),
  evidenceCommit: v.pipe(
    v.string(),
    v.regex(COMMIT_PATTERN, "Invalid evidence commit"),
  ),
  guide: v.strictObject({
    slug: StableIdSchema,
    title: NonEmptyTextSchema,
  }),
  profile: v.picklist(SCREENSHOT_PROFILE_NAMES),
  recordedCommit: v.pipe(
    v.string(),
    v.regex(COMMIT_PATTERN, "Invalid recorded commit"),
  ),
  schemaVersion: v.literal(1),
});
/* jscpd:ignore-end */

export function parseGuideFreshnessBaseline(
  input: unknown,
): GuideFreshnessBaseline {
  return parseDocument({ input, schema: BaselineSchema });
}
