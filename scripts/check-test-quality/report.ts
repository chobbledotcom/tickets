import { escapeAnnotationValue } from "../github-actions.ts";
import type { TestQualityFinding } from "../test-quality-audit-model.ts";

/** One finding rendered the way the audit names it. */
export const formatQualityFinding = (finding: TestQualityFinding): string =>
  `${finding.path}:${finding.line}:${finding.column} ${finding.message}`;

export const MAX_QUALITY_ANNOTATIONS = 100;

/** One `::warning` annotation per finding, capped so a wide backlog cannot
 *  flood the GitHub checks pane. */
export const qualityAnnotations = (
  findings: readonly TestQualityFinding[],
): string[] => {
  const shown = findings.slice(0, MAX_QUALITY_ANNOTATIONS);
  const annotations = shown.map(
    (finding) =>
      `::warning file=${escapeAnnotationValue(finding.path)},line=${finding.line},col=${finding.column}::${escapeAnnotationValue(finding.message)}`,
  );
  if (findings.length > MAX_QUALITY_ANNOTATIONS) {
    annotations.push(
      `::warning::${findings.length - MAX_QUALITY_ANNOTATIONS} further weak-assertion findings omitted`,
    );
  }
  return annotations;
};

export type QualityVerdict = {
  /** The always-printed informational block, header line first. */
  informational: string[];
  /** Findings in files this change touched — the review gate's list. */
  gateFindings: TestQualityFinding[];
  /** True when the gate could not run because the base ref is missing. */
  gateSkipped: boolean;
};

/** Split the audit's findings into the informational report and the review
 *  gate's list. `changedTestFiles` is the change's own test files against the
 *  merge base, or null when no base ref exists and the gate must skip. */
export const qualityVerdict = (
  findings: readonly TestQualityFinding[],
  changedTestFiles: readonly string[] | null,
): QualityVerdict => {
  const informational =
    findings.length === 0
      ? ["Test quality audit found no weak assertion patterns."]
      : [
          `Test quality audit found ${findings.length} review targets:`,
          ...findings.map(formatQualityFinding),
        ];
  if (changedTestFiles === null) {
    return { gateFindings: [], gateSkipped: true, informational };
  }
  const changed = new Set(changedTestFiles);
  return {
    gateFindings: findings.filter((finding) => changed.has(finding.path)),
    gateSkipped: false,
    informational,
  };
};

/** The failure lines for a gate that found weak assertions in touched files. */
export const gateReport = (
  gateFindings: readonly TestQualityFinding[],
): string[] => [
  "The test files this change touches carry weak assertion patterns.",
  "Fix them, or record why the pattern is right, before the change lands:",
  ...gateFindings.map(formatQualityFinding),
];
