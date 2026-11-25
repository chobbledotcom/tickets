/**
 * The freshness score: compare what each published guide used with what the
 * Cucumber evidence shows now. A changed anchor is not a failure. It is a
 * signal that the video may no longer show the site a viewer will meet.
 */

import { requireValue } from "#shared/required-value.ts";
import type { GuideFreshnessBaseline } from "./baseline.ts";
import { edgeSimilarity, freshnessPercent } from "./edge-hash.ts";
import type { StoryboardEvidence } from "./storyboard.ts";

/** The score at or under which the check asks the maintainer to choose. */
export const GUIDE_WARN_BELOW_PERCENT = 80;
const FRESH_PERCENT = 99;

export type FreshnessStatus = "fresh" | "aging" | "stale";

export interface GuideAnchorFreshness {
  captureId: string;
  caseId: string;
  percent: number;
  status: FreshnessStatus;
}

export interface GuideFreshness {
  anchors: readonly GuideAnchorFreshness[];
  percent: number;
  slug: string;
  status: FreshnessStatus;
  title: string;
}

export interface FreshnessReport {
  guides: readonly GuideFreshness[];
  overallPercent: number;
  warnBelowPercent: number;
}

export const statusForPercent = (percent: number): FreshnessStatus =>
  percent >= FRESH_PERCENT
    ? "fresh"
    : percent >= GUIDE_WARN_BELOW_PERCENT
      ? "aging"
      : "stale";

const averagePercent = (values: readonly number[]): number => {
  if (values.length === 0) throw new Error("A score needs at least one value");
  return Math.round(
    values.reduce((total, value) => total + value, 0) / values.length,
  );
};

/** The facts a guide's storyboard gives the check: its name and the captures
 * it uses, in order. */
export interface GuideToGrade {
  evidence: readonly StoryboardEvidence[];
  slug: string;
  title: string;
}

/** The baseline must name exactly the captures the storyboard uses. A guide
 * whose storyboard changed after the recording must be recorded again. */
const checkBaselineMatches = (
  guide: GuideToGrade,
  baseline: GuideFreshnessBaseline,
): void => {
  const used = new Set(guide.evidence.map(({ captureId }) => captureId));
  for (const captureId of Object.keys(baseline.anchors)) {
    if (!used.has(captureId)) {
      throw new Error(
        `The baseline for ${guide.slug} names ${captureId}, which the storyboard no longer uses. Record the guide again.`,
      );
    }
  }
};

/** Grade one guide. `current` is keyed by capture id, so a guide that names a
 * capture the evidence run no longer produces fails at that name. */
export const gradeGuide = (
  guide: GuideToGrade,
  baseline: GuideFreshnessBaseline,
  current: Readonly<Record<string, string>>,
): GuideFreshness => {
  checkBaselineMatches(guide, baseline);
  const anchors = guide.evidence.map(
    ({ captureId, caseId }): GuideAnchorFreshness => {
      const recorded = requireValue(
        baseline.anchors[captureId],
        `The baseline for ${guide.slug} has no ${captureId}. Record the guide again.`,
      );
      const now = requireValue(
        current[captureId],
        `No evidence capture ${captureId} for guide ${guide.slug}`,
      );
      const percent = freshnessPercent(edgeSimilarity(recorded, now));
      return { captureId, caseId, percent, status: statusForPercent(percent) };
    },
  );
  const percent = averagePercent(anchors.map(({ percent }) => percent));
  return {
    anchors,
    percent,
    slug: guide.slug,
    status: statusForPercent(percent),
    title: guide.title,
  };
};

export const buildFreshnessReport = (
  guides: readonly GuideFreshness[],
): FreshnessReport => ({
  guides,
  overallPercent: averagePercent(guides.map(({ percent }) => percent)),
  warnBelowPercent: GUIDE_WARN_BELOW_PERCENT,
});

export interface GuideNeedingAttention {
  /** The anchors that fell below the warning line. Empty when only the whole
   * guide did. */
  anchors: readonly GuideAnchorFreshness[];
  guide: GuideFreshness;
}

/** A guide needs attention when its own score falls below the line, or when
 * any one of its anchors does. One moved page is enough to make a chapter
 * wrong, even when the rest of the video is still fresh. */
export const staleGuides = (
  report: FreshnessReport,
): readonly GuideNeedingAttention[] =>
  report.guides.flatMap((guide) => {
    const anchors = guide.anchors.filter(
      ({ percent }) => percent < report.warnBelowPercent,
    );
    return guide.percent < report.warnBelowPercent || anchors.length > 0
      ? [{ anchors, guide }]
      : [];
  });

export const freshnessReportLines = (
  report: FreshnessReport,
): readonly string[] => [
  "Guide freshness against the Cucumber evidence",
  "",
  ...report.guides.flatMap((guide) => [
    `${guide.slug}  ${guide.percent}%  ${guide.status}  (${guide.title})`,
    ...guide.anchors.map(
      (anchor) =>
        `  ${anchor.captureId}  ${anchor.percent}%  ${anchor.status}  (${anchor.caseId})`,
    ),
  ]),
  "",
  `Overall ${report.overallPercent}%  (warn below ${report.warnBelowPercent}%)`,
];
