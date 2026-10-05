/**
 * The comment-language check's records and report: the per-file finding
 * counts the baseline keeps, and the compare that lets a count only fall
 * (see "Simplified Technical English — How We Write Documentation" in
 * AGENTS.md). The ratchet and the compare are the shared ones in
 * `check-runner.ts`, driven by `scripts/check-comments-ste.ts`.
 */

/* jscpd:ignore-start -- imports */
import { type CheckOutput, reportCheck } from "#scripts/check-report.ts";
import {
  type Counts,
  compareCounts,
  type PerFileFinding,
  type Registry,
  staleEntryLines,
} from "#scripts/check-runner.ts";
import { countBy } from "#scripts/count-by.ts";
import {
  collectFromFiles,
  collectGateScriptFiles,
} from "#scripts/walk-files.ts";
import { isShippedMigration } from "./run.ts";
import { findCommentSteIssues } from "./ste.ts";
/* jscpd:ignore-end */

/** One scanned file and the findings its comments carry. */
export interface CommentFile {
  file: string;
  findings: readonly PerFileFinding[];
}

/** The finding count one file holds per rule today. */
export const countsByRule = countBy(
  (finding: { rule: string }) => finding.rule,
);

/** Every authored source file under `root`, with the findings its comments
 * carry. Shipped dated migrations stay out: their prose is append-only
 * history the repo declines to edit. */
export const readCommentFiles = (root: string): Promise<CommentFile[]> =>
  collectFromFiles([root], collectGateScriptFiles, (file, content) =>
    isShippedMigration(file)
      ? []
      : [{ file, findings: findCommentSteIssues(content) }],
  );

/** The baseline one tree holds today, one entry per file with findings.
 * Files whose comments are clean hold no entry. */
export const freshBaseline = async (
  files: readonly CommentFile[],
): Promise<Registry> =>
  Object.fromEntries(
    files
      .map(({ file, findings }) => [file, countsByRule(findings)] as const)
      .filter(([, counts]) => Object.keys(counts).length > 0),
  );

/** One file's findings against its recorded counts. */
const findingsFor = (
  file: string,
  findings: readonly PerFileFinding[],
  recorded: Counts,
): string[] =>
  compareCounts({
    current: countsByRule(findings),
    file,
    findings,
    keyOf: (finding) => finding.rule,
    recorded,
    updateCommand: "deno task check:comment-ste --update",
    whereOf: (finding) => `${file}:${finding.line}`,
  });

/**
 * Compare every scanned file's comments against the baseline. A rule above
 * its recorded count reports its findings. A file that now counts fewer asks
 * for the baseline to record the step, so an improvement lands together with
 * its ratchet step. A baseline entry whose file the scan no longer reads
 * fails, because the list only shrinks. Returns the process exit code: 0
 * when clean, 1 otherwise.
 */
export const runCommentSteCheck = (
  files: readonly CommentFile[],
  baseline: Registry,
  output: CheckOutput,
): number => {
  const found = [
    ...files.flatMap(({ file, findings }) =>
      findingsFor(file, findings, baseline[file] ?? {}),
    ),
    ...staleEntryLines(
      files.map(({ file }) => file),
      Object.keys(baseline),
      "ste-baseline.json",
      "delete the entry",
    ),
  ];
  return reportCheck({
    ...output,
    found,
    guide: '"Simplified Technical English" in AGENTS.md',
    noun: "comment-language",
    success:
      "Every comment holds no comment-language finding above its recorded counts.",
  });
};
