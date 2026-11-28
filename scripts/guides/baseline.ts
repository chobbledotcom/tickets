/**
 * What a published guide used at the moment it was recorded: the edge hash of
 * each Cucumber capture, keyed by capture id. The storyboard holds the guide
 * title and the case of each capture, so the baseline does not repeat them.
 */

import * as v from "valibot";
import { EDGE_HASH_PATTERN } from "./edge-hash.ts";
import { parserFor, StableIdSchema } from "./schema-parts.ts";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export interface GuideFreshnessBaseline {
  anchors: Readonly<Record<string, string>>;
  recordedCommit: string;
  schemaVersion: 2;
}

const BaselineSchema = v.strictObject({
  anchors: v.pipe(
    v.record(
      StableIdSchema,
      v.pipe(v.string(), v.regex(EDGE_HASH_PATTERN, "Invalid edge hash")),
    ),
    v.check(
      (anchors) => Object.keys(anchors).length > 0,
      "A baseline needs at least one anchor",
    ),
  ),
  recordedCommit: v.pipe(
    v.string(),
    v.regex(COMMIT_PATTERN, "Invalid recorded commit"),
  ),
  schemaVersion: v.literal(2),
});

export function parseGuideFreshnessBaseline(
  input: unknown,
): GuideFreshnessBaseline {
  return parserFor(BaselineSchema)(input);
}
