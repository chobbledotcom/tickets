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

const IS_A_PLAIN_WORD = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** How a reader reaches one more name from where they already are. A plain
 * word goes after a dot. Any other name needs brackets and quotes, exactly as
 * the code that reads it does, so a name that holds a dot cannot read like a
 * path of its own. */
export const reaching = (path: string, name: string): string =>
  IS_A_PLAIN_WORD.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`;

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
    .sort((a, b) =>
      a.file === b.file
        ? reaching(a.owner, a.field).localeCompare(reaching(b.owner, b.field))
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
      `  ${finding.verdict.padEnd(19)} ${reaching(finding.owner, finding.field)}` +
        `  ${finding.file}`,
    );
  }
  return lines;
};
