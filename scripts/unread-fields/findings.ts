/**
 * What the scan concluded about one field, and how it reads on the console.
 */

import {
  compareFindingIdentities,
  compareText,
  type FindingIdentity,
  findingPath,
} from "#scripts/unread-fields/identity.ts";

/** Where a field's readers live, if it has any. */
export type Verdict = "read" | "never read" | "read only by tests";

/** One exported field the scan looked at. */
export interface Finding extends FindingIdentity {
  /** The file that declares it, relative to the repository. */
  file: string;
  /** The readable path to the shape that owns the field. */
  owner: string;
  verdict: Verdict;
}

/** Folders that hold tests. `scripts/email-sandbox-e2e/` and `e2e-payments/`
 * are live end-to-end harnesses, so a field only one of them reads is kept
 * alive by a test like any other. */
const TEST_FOLDERS = ["test/", "scripts/email-sandbox-e2e/", "e2e-payments/"];

const isTest = (file: string): boolean =>
  TEST_FOLDERS.some((folder) => file.startsWith(folder));

/** A field nothing reads is written for nobody. A field only its tests read
 * is kept alive by the tests themselves, which is the same thing in a
 * disguise. Both are worth a person's attention; a field production reads
 * is not. */
export const verdictFor = (readers: string[]): Verdict => {
  if (readers.length === 0) return "never read";
  return readers.every(isTest) ? "read only by tests" : "read";
};

/** The findings a report prints, in file order so a reader can work down one
 * file at a time. */
export const worthReporting = (findings: Finding[]): Finding[] =>
  findings
    .filter((finding) => finding.verdict !== "read")
    .sort((left, right) =>
      left.file === right.file
        ? compareFindingIdentities(left, right)
        : compareText(left.file, right.file),
    );

const countOf = (findings: Finding[], verdict: Verdict): number =>
  findings.filter((finding) => finding.verdict === verdict).length;

/** The report. Empty findings still print a line, so a run always says what
 * it concluded. */
export const reportLines = (findings: Finding[]): string[] => {
  const worth = worthReporting(findings);
  if (worth.length === 0) {
    return [`Every exported field of the ${findings.length} scanned is read.`];
  }
  const lines = [
    `${worth.length} of ${findings.length} exported fields are never read` +
      ` in production: ${countOf(worth, "never read")} read by nothing,` +
      ` ${countOf(worth, "read only by tests")} read only by tests.`,
    "",
  ];
  for (const finding of worth) {
    lines.push(
      `  ${finding.verdict.padEnd(19)} ${findingPath(finding)}` +
        `  ${finding.file}`,
    );
  }
  return lines;
};
