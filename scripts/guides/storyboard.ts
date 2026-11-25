/**
 * A guide is a list of real browser actions. The recorder runs the setup
 * actions once, then records the story actions at human speed. A guide names
 * the Cucumber captures it uses as visual references, so a later check can say
 * when the video has drifted from what the site shows now.
 *
 * The storyboard is data, not code: adding a guide must not add a branch to the
 * recorder or the renderer.
 */

import * as v from "valibot";
import { integerAtLeast } from "#shared/validation/number.ts";
import { NonEmptyTextSchema, StableIdSchema } from "./schema-parts.ts";

const WHOLE_ADDRESS_PATTERN = /^\/(?!.*\{).*$/;

const WholeAddressSchema = v.pipe(
  NonEmptyTextSchema,
  v.regex(WHOLE_ADDRESS_PATTERN, "Guide path must be a whole address"),
);
const WholeNumberSchema = integerAtLeast(0);

export interface GuideViewport {
  fps: number;
  height: number;
  width: number;
}

export type GuideAction =
  | { kind: "open"; path: string }
  | { kind: "click"; selector: string }
  | { kind: "openLink"; selector: string }
  | {
      kind: "type";
      selector: string;
      text: string;
      perCharacterMs?: number | undefined;
    }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "select"; selector: string; value: string }
  | { kind: "check"; selector: string }
  | {
      kind: "scroll";
      deltaY: number;
      settleMs?: number | undefined;
      steps?: number | undefined;
    }
  | {
      kind: "focus";
      selector: string;
      scale?: number | undefined;
      transitionMs?: number | undefined;
    }
  | { kind: "blur"; transitionMs?: number | undefined }
  | {
      kind: "upload";
      selector: string;
      name: string;
      altText?: string | undefined;
    }
  | { kind: "wait"; ms: number }
  | { kind: "evidence"; captureId: string; caseId: string };

export interface GuideStoryboard {
  actions: readonly GuideAction[];
  fps: number;
  setup: readonly GuideAction[];
  slug: string;
  title: string;
}

/* jscpd:ignore-start -- the action table is static data, one shape per action */
const ActionSchema: v.GenericSchema<GuideAction> = v.variant("kind", [
  v.strictObject({ kind: v.literal("open"), path: WholeAddressSchema }),
  v.strictObject({ kind: v.literal("click"), selector: NonEmptyTextSchema }),
  v.strictObject({ kind: v.literal("openLink"), selector: NonEmptyTextSchema }),
  v.strictObject({
    kind: v.literal("type"),
    perCharacterMs: v.optional(integerAtLeast(1)),
    selector: NonEmptyTextSchema,
    text: NonEmptyTextSchema,
  }),
  v.strictObject({
    kind: v.literal("fill"),
    selector: NonEmptyTextSchema,
    value: NonEmptyTextSchema,
  }),
  v.strictObject({
    kind: v.literal("select"),
    selector: NonEmptyTextSchema,
    value: NonEmptyTextSchema,
  }),
  v.strictObject({ kind: v.literal("check"), selector: NonEmptyTextSchema }),
  v.strictObject({
    deltaY: v.pipe(
      v.number(),
      v.safeInteger(),
      v.minValue(-100_000),
      v.maxValue(100_000),
    ),
    kind: v.literal("scroll"),
    settleMs: v.optional(WholeNumberSchema),
    steps: v.optional(integerAtLeast(1)),
  }),
  v.strictObject({
    kind: v.literal("focus"),
    scale: v.optional(v.pipe(v.number(), v.minValue(0.1), v.maxValue(5))),
    selector: NonEmptyTextSchema,
    transitionMs: v.optional(WholeNumberSchema),
  }),
  v.strictObject({
    kind: v.literal("blur"),
    transitionMs: v.optional(WholeNumberSchema),
  }),
  v.strictObject({
    altText: v.optional(NonEmptyTextSchema),
    kind: v.literal("upload"),
    name: NonEmptyTextSchema,
    selector: NonEmptyTextSchema,
  }),
  v.strictObject({ kind: v.literal("wait"), ms: WholeNumberSchema }),
  v.strictObject({
    captureId: StableIdSchema,
    caseId: StableIdSchema,
    kind: v.literal("evidence"),
  }),
]);
/* jscpd:ignore-end */

/* jscpd:ignore-start -- the storyboard document is static data */
const StoryboardSchema = v.strictObject({
  actions: v.pipe(v.array(ActionSchema), v.minLength(1)),
  fps: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(60)),
  setup: v.array(ActionSchema),
  slug: StableIdSchema,
  title: NonEmptyTextSchema,
});
/* jscpd:ignore-end */

/** A Cucumber capture a guide uses, and the case that makes it. */
export interface StoryboardEvidence {
  captureId: string;
  caseId: string;
}

/** The evidence captures a storyboard uses, in the order it first uses one. */
export const storyboardEvidence = (
  storyboard: GuideStoryboard,
): StoryboardEvidence[] => {
  const seen = new Set<string>();
  const found: StoryboardEvidence[] = [];
  for (const action of storyboard.actions) {
    if (action.kind !== "evidence" || seen.has(action.captureId)) continue;
    seen.add(action.captureId);
    found.push({ captureId: action.captureId, caseId: action.caseId });
  }
  return found;
};

export const parseGuideStoryboard = (input: unknown): GuideStoryboard => {
  const storyboard = v.parse(StoryboardSchema, input);
  if (storyboard.setup.some(({ kind }) => kind === "evidence")) {
    throw new Error("A guide setup cannot declare evidence");
  }
  const evidence = storyboardEvidence(storyboard);
  if (evidence.length === 0) {
    throw new Error("A guide must declare at least one evidence capture");
  }
  const evidenceActions = storyboard.actions.filter(
    ({ kind }) => kind === "evidence",
  ).length;
  if (evidenceActions !== evidence.length) {
    throw new Error("A guide cannot use the same evidence capture twice");
  }
  return storyboard;
};
