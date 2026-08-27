/**
 * What the scan concluded about one field, and how it reads on the console.
 */

/** Where a field's readers live, if it has any. */
export type Verdict = "read" | "never read" | "read only by tests";

/** One exported field the scan looked at. */
export interface Finding {
  /** The field itself. */
  field: string;
  /** The file that declares it, relative to the repository. */
  file: string;
  /** The exported shape the field belongs to, and the path down to it. */
  owner: string;
  verdict: Verdict;
}

/** Folders that hold tests. `scripts/email-sandbox-e2e/` is a live end-to-end
 * harness, so a field only it reads is kept alive by a test like any other. */
const TEST_FOLDERS = ["test/", "scripts/email-sandbox-e2e/"];

const isTest = (file: string): boolean =>
  TEST_FOLDERS.some((folder) => file.startsWith(folder));

/** A field nothing reads is written for nobody. A field only its tests read
 * is kept alive by the tests themselves, which is the same thing wearing a
 * disguise. Both are worth a person's attention; a field production reads
 * is not. */
export const verdictFor = (readers: string[]): Verdict => {
  if (readers.length === 0) return "never read";
  return readers.every(isTest) ? "read only by tests" : "read";
};

/** The findings worth printing, in file order so a reader can work down one
 * file at a time. */
export const worthReporting = (findings: Finding[]): Finding[] =>
  findings
    .filter((finding) => finding.verdict !== "read")
    .sort((a, b) =>
      a.file === b.file
        ? `${a.owner}.${a.field}`.localeCompare(`${b.owner}.${b.field}`)
        : a.file.localeCompare(b.file),
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
      `  ${finding.verdict.padEnd(19)} ${finding.owner}.${finding.field}` +
        `  ${finding.file}`,
    );
  }
  return lines;
};
