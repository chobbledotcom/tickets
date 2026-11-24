/**
 * The freshness score: compare what each published guide used with what the
 * Cucumber evidence shows now. A changed anchor is not a failure. It is a
 * signal that the video may no longer show the site a viewer will meet.
 */

import type { GuideFreshnessBaseline } from "./baseline.ts";
import {
  compareFingerprints,
  freshnessPercent,
  type GuideFingerprint,
} from "./fingerprint.ts";

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

/** Grade one guide. `current` is keyed by capture id, so a guide that names a
 * capture the evidence run no longer produces fails at that name. */
export const gradeGuide = (
  baseline: GuideFreshnessBaseline,
  current: Readonly<Record<string, GuideFingerprint>>,
): GuideFreshness => {
  const anchors = baseline.anchors.map((anchor): GuideAnchorFreshness => {
    const now = current[anchor.captureId];
    if (!now) {
      throw new Error(
        `No ${baseline.profile} evidence capture ${anchor.captureId} for guide ${baseline.guide.slug}`,
      );
    }
    const percent = freshnessPercent(compareFingerprints(anchor, now));
    return {
      captureId: anchor.captureId,
      caseId: anchor.caseId,
      percent,
      status: statusForPercent(percent),
    };
  });
  const percent = averagePercent(anchors.map(({ percent }) => percent));
  return {
    anchors,
    percent,
    slug: baseline.guide.slug,
    status: statusForPercent(percent),
    title: baseline.guide.title,
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
