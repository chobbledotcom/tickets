import { escapeAnnotationValue } from "#scripts/check-report.ts";
import type { TestQualityFinding } from "#scripts/test-quality-audit-model.ts";

/**
 * The test-quality gate: a test file the branch touches must hold no weak
 * assertion at all, compared with the merge base on `origin/main` — one the
 * change adds and one it inherits both fail. Removing a weak assertion is the
 * only way out. See "Test Quality Standards" in AGENTS.md.
 */

/** Where a reader finds the rule and the way out. */
export const RATCHET_GUIDE = '"Test Quality Standards" in AGENTS.md';

const MAX_GITHUB_ANNOTATIONS = 100;

/** A finding's identity for ratchet comparison: path and message, without the
 * line, so a weak assertion that moves within a touched file stays known. */
export const findingKey = (finding: TestQualityFinding): string =>
  `${finding.path}\u0000${finding.message}`;

/** The identities a finding list holds, for set-membership checks. */
export const findingKeySet = (
  findings: readonly TestQualityFinding[],
): Set<string> => new Set(findings.map(findingKey));

/** Split HEAD's findings by what the merge base holds in the same file:
 * `added` are weak assertions the change introduces, `existing` are the
 * ones it only moves or leaves in place. */
export const partitionFindings = (
  head: readonly TestQualityFinding[],
  base: readonly TestQualityFinding[],
): { added: TestQualityFinding[]; existing: TestQualityFinding[] } => {
  const baseKeys = findingKeySet(base);
  const added: TestQualityFinding[] = [];
  const existing: TestQualityFinding[] = [];
  for (const finding of head) {
    if (baseKeys.has(findingKey(finding))) existing.push(finding);
    else added.push(finding);
  }
  return { added, existing };
};

/** One gate finding line in the format every repo-wide check uses. */
export const formatGateFinding = (finding: TestQualityFinding): string =>
  `${finding.path}:${finding.line}:${finding.column} ${finding.message}`;

/** The GitHub Actions annotation lines for one run, or none outside CI. Every
 * finding the gate reports fails the run, so each annotation is an error.
 * The cap keeps a long finding list from flooding the run log. */
export const annotationLines = (
  added: readonly TestQualityFinding[],
  existing: readonly TestQualityFinding[],
  inCi: boolean,
): string[] => {
  if (!inCi) return [];
  const entries = [...added, ...existing];
  const lines = entries
    .slice(0, MAX_GITHUB_ANNOTATIONS)
    .map(
      (finding) =>
        `::error file=${escapeAnnotationValue(finding.path)},line=${finding.line}::${escapeAnnotationValue(finding.message)}`,
    );
  if (entries.length > MAX_GITHUB_ANNOTATIONS) {
    lines.push(
      `::warning::${entries.length - MAX_GITHUB_ANNOTATIONS} additional weak-assertion annotations omitted; see the test quality gate report below`,
    );
  }
  return lines;
};
